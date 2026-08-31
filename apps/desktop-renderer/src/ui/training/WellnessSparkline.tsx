import type { WellnessSeries } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { overviewStyles as styles } from "./overviewStyles";

export function WellnessSparkline(props: {
  readonly series: WellnessSeries;
}): ReactElement {
  const points = props.series.points;
  if (points.length === 0) {
    return <span className={styles.wellnessEmpty}>No readings</span>;
  }
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const denominator = Math.max(1, points.length - 1);
  const path = points
    .map((point, index) => {
      const x = (index / denominator) * 116 + 2;
      const y = minimum === maximum ? 15 : 27 - ((point.value - minimum) / (maximum - minimum)) * 24;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg className={styles.sparkline} viewBox="0 0 120 30" aria-hidden="true">
      <polyline points={path} />
    </svg>
  );
}
