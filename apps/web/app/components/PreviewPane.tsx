"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { previewUrl } from "@slate/shared/port-detect";

export interface PreviewPaneProps {
  /** The port the terminal announced, or null while no server is running. */
  port: number | null;
}

export default function PreviewPane({ port }: PreviewPaneProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [popped, setPopped] = useState(false);
  const [popRect, setPopRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [interacting, setInteracting] = useState(false);

  const url = port === null ? null : previewUrl(port);

  // Close the pop-out if the preview URL disappears (server stopped, etc.).
  useEffect(() => {
    if (popped && url === null) setPopped(false);
  }, [popped, url]);

  const handlePopOut = useCallback(() => {
    if (url === null) return;
    setPopRect({
      x: Math.max(0, Math.round((window.innerWidth - Math.min(window.innerWidth - 40, 1280)) / 2)),
      y: Math.max(0, Math.round((window.innerHeight - Math.min(window.innerHeight - 40, 820)) / 2)),
      w: Math.min(window.innerWidth - 40, 1280),
      h: Math.min(window.innerHeight - 40, 820),
    });
    setPopped(true);
  }, [url]);

  const handleDock = useCallback(() => setPopped(false), []);

  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const onHeaderMouseDown = useCallback(
    (event: React.MouseEvent) => {
      // Buttons inside the header (Reload, Dock) must keep their own click behaviour;
      // don't start a drag or swallow the event when one of them is the target.
      const target = event.target as HTMLElement | null;
      if (target !== null && target.closest("button") !== null) return;
      if (popRect === null) return;
      event.preventDefault();
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        origX: popRect.x,
        origY: popRect.y,
      };
      setInteracting(true);
      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (drag === null) return;
        setPopRect((current) =>
          current === null
            ? current
            : {
                ...current,
                x: Math.max(0, Math.min(window.innerWidth - 120, drag.origX + (ev.clientX - drag.startX))),
                y: Math.max(0, Math.min(window.innerHeight - 40, drag.origY + (ev.clientY - drag.startY))),
              },
        );
      };
      const onUp = () => {
        dragRef.current = null;
        setInteracting(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [popRect],
  );

  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);
  const onResizeMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (popRect === null) return;
      setInteracting(true);
      resizeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        origW: popRect.w,
        origH: popRect.h,
      };
      const onMove = (ev: MouseEvent) => {
        const resize = resizeRef.current;
        if (resize === null) return;
        setPopRect((current) =>
          current === null
            ? current
            : {
                ...current,
                w: Math.max(320, resize.origW + (ev.clientX - resize.startX)),
                h: Math.max(240, resize.origH + (ev.clientY - resize.startY)),
              },
        );
      };
      const onUp = () => {
        resizeRef.current = null;
        setInteracting(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [popRect],
  );

  const refresh = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  return (
    <>
    <div className="preview-pane">
      <div className="preview-toolbar">
        <button
          type="button"
          onClick={refresh}
          disabled={url === null}
          title="Reload the preview"
        >
          Refresh
        </button>

        <span className="preview-port-label" title="The port the terminal server announced">
          {port === null ? "No port" : `Port ${port}`}
        </span>

        <button
          type="button"
          onClick={popped ? handleDock : handlePopOut}
          disabled={url === null}
          title={popped ? "Return the preview to the pane" : "Open in a floating window"}
        >
          {popped ? "Dock" : "Pop out"}
        </button>
      </div>

      {url === null || popped ? (
        <div className="preview-empty">
          <p>{popped ? "Preview is open in a floating window." : "No terminal server yet."}</p>
          {!popped && (
            <p className="meta">
              Run your server in the Terminal. The preview appears once it prints a port, and it
              frames that exact port. Nothing starts on its own.
            </p>
          )}
        </div>
      ) : (
        <iframe
          key={`${url}-${reloadKey}`}
          className="preview-frame"
          src={url}
          title="Project preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      )}
    </div>

    {popped && url !== null && popRect !== null && (
      <div
        className="preview-popout"
        style={{
          position: "fixed",
          left: `${popRect.x}px`,
          top: `${popRect.y}px`,
          width: `${popRect.w}px`,
          height: `${popRect.h}px`,
          zIndex: 10000,
        }}
      >
        <div className="preview-popout-header">
          <span className="preview-popout-title" onMouseDown={onHeaderMouseDown}>Preview — {url}</span>
          <div className="preview-popout-actions">
            <button type="button" onClick={() => setReloadKey((current) => current + 1)} title="Reload">
              ↻
            </button>
            <button type="button" onClick={handleDock} title="Dock back into the pane">
              Dock
            </button>
          </div>
        </div>
        <iframe
          key={`${url}-${reloadKey}`}
          className="preview-popout-frame"
          src={url}
          title="Project preview (popped out)"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          style={{ pointerEvents: interacting ? "none" : "auto" }}
        />
        <div className="preview-popout-resize" onMouseDown={onResizeMouseDown} title="Drag to resize" />
      </div>
    )}
  </>
);

}
