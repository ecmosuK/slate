/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared and bridge packages ship TypeScript source, so they have to go through the compiler.
  transpilePackages: ["@slate/shared", "@slate/bridge"],
  // node-pty is a native addon; webpack must leave it alone.
  serverExternalPackages: ["node-pty"],
};

export default nextConfig;
