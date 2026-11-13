import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface TerminalDependencySetup {
  /** Fixed, manifest-derived install script; never supplied by the browser. */
  command: string;
  /** Activate the project's Python virtual environment without reinstalling dependencies. */
  activateCommand: string | null;
  /** True when this project's `.venv` already exists. */
  venvExists: boolean;
  /** Changes when a dependency manifest or lockfile changes. */
  fingerprint: string;
  label: string;
  successMarker: string;
  failureMarker: string;
  activationMarker: string;
}

export const DEPENDENCY_SETUP_SUCCESS = "__SLATE_DEPENDENCIES_READY__";
export const DEPENDENCY_SETUP_FAILURE = "__SLATE_DEPENDENCIES_FAILED__";
export const VENV_ACTIVATION_SUCCESS = "__SLATE_VENV_ACTIVE__";

function readFileIfPresent(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path, "utf8");
}

/** Build a safe install command from the project's standard dependency manifests. */
export function terminalDependencySetup(folder: string): TerminalDependencySetup | null {
  let nodeInstall: string | null = null;
  let pythonInstall: string | null = null;
  let pythonEnvironment = false;
  const fingerprintParts: string[] = [];
  const labels: string[] = [];

  const packageJson = readFileIfPresent(join(folder, "package.json"));
  if (packageJson !== null) {
    const packageLock = readFileIfPresent(join(folder, "package-lock.json"));
    nodeInstall = packageLock === null ? "npm install" : "npm ci";
    labels.push("Node.js dependencies");
    fingerprintParts.push("package.json", packageJson, "package-lock.json", packageLock ?? "");
  }

  const requirements = readFileIfPresent(join(folder, "requirements.txt"));
  if (requirements !== null) {
    pythonInstall = "python -m pip install --disable-pip-version-check --no-input --progress-bar off -r requirements.txt";
    pythonEnvironment = true;
    labels.push("Python dependencies");
    fingerprintParts.push("requirements.txt", requirements);
  }

  // A pyproject-only project is installable through pip. If requirements.txt is present, it is
  // the explicit dependency list and avoids installing the project twice.
  if (requirements === null) {
    const pyproject = readFileIfPresent(join(folder, "pyproject.toml"));
    if (pyproject !== null) {
      pythonInstall = "python -m pip install --disable-pip-version-check --no-input --progress-bar off .";
      pythonEnvironment = true;
      labels.push("Python project dependencies");
      fingerprintParts.push("pyproject.toml", pyproject);
    }
  }

  if (nodeInstall === null && pythonInstall === null) return null;

  const steps: string[] = [];
  if (nodeInstall !== null) {
    steps.push(`${nodeInstall}; if ($LASTEXITCODE -ne 0) { $setupFailed = $true }`);
  }
  if (pythonInstall !== null) {
    steps.push(
      "if (-not (Test-Path '.gitignore')) { Set-Content -Path '.gitignore' -Value '.venv/' } elseif (-not (Select-String -Path '.gitignore' -Pattern '(^|/)\\.venv/?($|/)' -Quiet)) { Add-Content -Path '.gitignore' -Value '.venv/' }",
      "if (-not $setupFailed) { if (-not (Test-Path '.venv')) { python -m venv .venv; if ($LASTEXITCODE -ne 0) { $setupFailed = $true } } }",
      `if (-not $setupFailed) { $env:VIRTUAL_ENV = (Resolve-Path '.venv').Path; $env:PATH = (Join-Path $env:VIRTUAL_ENV 'Scripts') + [IO.Path]::PathSeparator + $env:PATH; ${pythonInstall}; if ($LASTEXITCODE -ne 0) { $setupFailed = $true } }`,
    );
  }

  const command =
    process.platform === "win32"
      ? `$setupFailed = $false; ${steps.join("; ")}; if ($setupFailed) { Write-Output '${DEPENDENCY_SETUP_FAILURE}' } else { Write-Output '${DEPENDENCY_SETUP_SUCCESS}' }`
      : [
          "setup_failed=0",
          ...(nodeInstall === null ? [] : [`${nodeInstall} || setup_failed=1`]),
          ...(pythonInstall === null
            ? []
            : [
                "if [ -f .gitignore ]; then grep -Eq '(^|/)\\.venv/?($|/)' .gitignore || printf '.venv/\\n' >> .gitignore; else printf '.venv/\\n' > .gitignore; fi",
                "if [ ! -d .venv ]; then python -m venv .venv || setup_failed=1; fi",
                `if [ "$setup_failed" -eq 0 ]; then .venv/bin/python -m pip install --disable-pip-version-check --no-input --progress-bar off ${pythonInstall.endsWith("requirements.txt") ? "-r requirements.txt" : "."} || setup_failed=1; fi`,
              ]),
          `if [ "$setup_failed" -eq 0 ]; then printf '%s\\n' '${DEPENDENCY_SETUP_SUCCESS}'; else printf '%s\\n' '${DEPENDENCY_SETUP_FAILURE}'; fi`,
        ].join("; ");

  const activateCommand = pythonEnvironment
    ? process.platform === "win32"
      ? `if (Test-Path '.venv\\Scripts\\python.exe') { $env:VIRTUAL_ENV = (Resolve-Path '.venv').Path; $env:PATH = (Join-Path $env:VIRTUAL_ENV 'Scripts') + [IO.Path]::PathSeparator + $env:PATH; Write-Output '${VENV_ACTIVATION_SUCCESS}' } else { Write-Output '${DEPENDENCY_SETUP_FAILURE}' }`
      : `if [ -x .venv/bin/python ]; then export VIRTUAL_ENV="$PWD/.venv"; export PATH="$VIRTUAL_ENV/bin:$PATH"; printf '%s\\n' '${VENV_ACTIVATION_SUCCESS}'; else printf '%s\\n' '${DEPENDENCY_SETUP_FAILURE}'; fi`
    : null;

  return {
    command,
    activateCommand,
    venvExists: pythonEnvironment && existsSync(join(folder, ".venv")),
    fingerprint: createHash("sha256").update(fingerprintParts.join("\0")).digest("hex"),
    label: labels.join(" and "),
    successMarker: DEPENDENCY_SETUP_SUCCESS,
    failureMarker: DEPENDENCY_SETUP_FAILURE,
    activationMarker: VENV_ACTIVATION_SUCCESS,
  };
}
