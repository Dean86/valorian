/** The "?" toggle — tucks instructional copy behind a small button in the
 *  panel heading. Opens as a floating card: no layout shift, one click to
 *  learn, invisible once you know the tool. */

import { useEffect, useRef, useState, type ReactNode } from "react";

export function Help({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="help-wrap" ref={ref}>
      <button
        type="button"
        className={`help-toggle ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="how this works"
        title="how this works"
      >
        ?
      </button>
      {open && <div className="help-pop" role="note">{children}</div>}
    </span>
  );
}
