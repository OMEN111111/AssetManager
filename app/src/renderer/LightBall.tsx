import { useRef } from 'react';

export default function LightBall({ az, el, onChange }: { az: number; el: number; onChange: (a: number, e: number) => void }) {
  const drag = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const update = (e: any) => {
    const b = ref.current!.getBoundingClientRect();
    let x = ((e.clientX - b.left) / b.width) * 2 - 1;
    let y = ((e.clientY - b.top) / b.height) * 2 - 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    onChange(Math.round(x * 90), Math.round(y * 90));
  };
  return (
    <div className="lightball" ref={ref}
      onPointerDown={e => { drag.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); update(e); }}
      onPointerMove={e => { if (drag.current) update(e); }}
      onPointerUp={() => { drag.current = false; }}>
      <span className="lb-dot" style={{ left: `${50 + az / 1.8}%`, top: `${50 + el / 1.8}%` }} />
    </div>
  );
}
