import { useRef } from 'react';

interface Props {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  reset?: number;
  width?: number;
  digits?: number;
}

export default function NumField({ value, onChange, step = 0.01, min = -Infinity, max = Infinity, reset, width = 64, digits = 2 }: Props) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const round = (v: number) => Number(v.toFixed(digits));
  const apply = (v: number) => { if (Number.isFinite(v)) onChange(round(clamp(v))); };
  const drag = useRef<{ y: number; start: number } | null>(null);

  return (
    <div className="numfield" style={{ width }}>
      <input
        type="number"
        value={Number.isFinite(value) ? round(value) : 0}
        step={step}
        onChange={e => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) apply(n);
        }}
      />
      <span
        className="numarrows"
        title="拖动或滚轮调整；右键恢复默认"
        onPointerDown={e => {
          if (e.button === 2) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, start: value };
        }}
        onPointerMove={e => {
          if (!drag.current) return;
          const dy = drag.current.y - e.clientY;
          apply(drag.current.start + dy * step * (e.shiftKey ? 10 : 1));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={e => {
          e.preventDefault();
          apply(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 10 : 1));
        }}
        onContextMenu={e => {
          e.preventDefault();
          if (reset !== undefined) apply(reset);
        }}
      >
        <i>▲</i><i>▼</i>
      </span>
    </div>
  );
}
