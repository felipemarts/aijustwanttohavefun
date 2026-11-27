/**
 * Small hand-drawn SVG charts in the app's style (no chart library): one y axis, recessive grid, labelled axes,
 * a crosshair tooltip on hover/touch, a legend when there are two series, and a table view for screen readers and
 * anyone who prefers numbers. Width follows the container so the same chart reads on a phone and a wide screen.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/store';
import { extent, indexTicks, linearScale, linePath, niceTicks } from '../view/chart';

export type Series = { label: string; values: number[]; color: string; dashed?: boolean };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.max(220, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(220, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

type ChartProps = {
  title: string;
  /** Unit of the y axis, shown as its label. */
  yLabel: string;
  xLabel: string;
  /** One label per point (the days). */
  labels: string[];
  series: Series[];
  format: (v: number) => string;
  integer?: boolean;
  kind?: 'line' | 'bar';
  height?: number;
};

export function Chart({ title, yLabel, xLabel, labels, series, format, integer = false, kind = 'line', height = 220 }: ChartProps) {
  const tr = useT();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const tableId = useId();
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const [lo, hi] = extent(all);
  // Counts and gold are never negative: start the axis at zero so heights stay honest.
  const { ticks, domain } = niceTicks(lo >= 0 ? 0 : lo, hi, height < 180 ? 3 : 4, integer);
  const tickText = ticks.map(format);
  const left = Math.min(84, 30 + Math.max(...tickText.map((t) => t.length), 1) * 6.5);
  const pad = { top: 12, right: 14, bottom: 40, left };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const band = n > 0 ? plotW / n : plotW;
  const x = kind === 'bar'
    ? (i: number) => pad.left + band * i + band / 2
    : linearScale([0, Math.max(1, n - 1)], [pad.left, pad.left + plotW]);
  const y = linearScale(domain, [pad.top + plotH, pad.top]);
  const xt = indexTicks(n, Math.max(2, Math.floor(plotW / 78)));

  const onMove = (clientX: number, rect: DOMRect) => {
    if (!n) return;
    const px = clientX - rect.left;
    const i = kind === 'bar' ? Math.floor((px - pad.left) / band) : Math.round(((px - pad.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hx = hover !== null ? x(hover) : 0;
  const tipLeft = hover !== null && hx > width * 0.6;

  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-title">{title}</figcaption>
      {series.length > 1 ? (
        <ul className="chart-legend">
          {series.map((s) => (
            <li key={s.label}>
              <svg width="18" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="18" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chart-stage">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={title}
          aria-describedby={tableId}
          onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setHover(null)}
          onTouchStart={(e) => e.touches[0] && onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
          onTouchMove={(e) => e.touches[0] && onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
        >
          {ticks.map((t, i) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + plotW} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={i === 0 ? 'chart-base' : 'chart-grid'} />
              <text x={pad.left - 6} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                {tickText[i]}
              </text>
            </g>
          ))}
          {xt.map((i) => (
            <text key={i} x={x(i)} y={pad.top + plotH + 16} className="chart-tick" textAnchor={i === 0 && kind === 'line' ? 'start' : i === n - 1 && kind === 'line' ? 'end' : 'middle'}>
              {labels[i]}
            </text>
          ))}
          <text x={pad.left + plotW / 2} y={height - 4} className="chart-axis" textAnchor="middle">
            {xLabel}
          </text>
          <text transform={`translate(11 ${pad.top + plotH / 2}) rotate(-90)`} className="chart-axis" textAnchor="middle">
            {yLabel}
          </text>
          {kind === 'bar'
            ? series[0]?.values.map((v, i) => {
                const top = y(Math.max(0, v));
                const bw = Math.max(2, Math.min(28, band - 4));
                return (
                  <rect
                    key={i}
                    x={Math.round(x(i) - bw / 2)}
                    y={Math.round(top)}
                    width={Math.round(bw)}
                    height={Math.max(0, Math.round(y(domain[0]) - top))}
                    fill={series[0]!.color}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                );
              })
            : series.map((s) => (
                <path
                  key={s.label}
                  d={linePath(s.values.map((v, i) => ({ x: x(i), y: y(v) })))}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? '5 4' : undefined}
                  strokeLinejoin="round"
                />
              ))}
          {kind === 'line' && n === 1
            ? series.map((s) => <rect key={s.label} x={x(0) - 4} y={y(s.values[0] ?? 0) - 4} width={8} height={8} fill={s.color} />)
            : null}
          {hover !== null ? (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={pad.top} y2={pad.top + plotH} className="chart-cross" />
              {kind === 'line'
                ? series.map((s) => (
                    <rect key={s.label} x={Math.round(hx) - 4} y={Math.round(y(s.values[hover] ?? 0)) - 4} width={8} height={8} fill={s.color} stroke="#1b1726" strokeWidth={2} />
                  ))
                : null}
            </g>
          ) : null}
        </svg>
        {hover !== null ? (
          <div className="chart-tip pixel-box" style={tipLeft ? { insetInlineEnd: width - hx + 10 } : { insetInlineStart: hx + 10 }}>
            <div className="chart-tip-head">{labels[hover]}</div>
            {series.map((s) => (
              <div key={s.label} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
                <span>{s.label}</span>
                <b>{format(s.values[hover] ?? 0)}</b>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <details className="chart-table" id={tableId}>
        <summary>{tr.t('ui.chart.show_table')}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{xLabel}</th>
              {series.map((s) => (
                <th key={s.label} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={`${l}-${i}`}>
                <th scope="row">{l}</th>
                {series.map((s) => (
                  <td key={s.label}>{format(s.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
