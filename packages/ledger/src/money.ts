/** Integer-cent helpers shared by the posting modules. */
export const cents = (v: number | string): number =>
  Math.round(Number(v) * 100);
export const centsToStr = (c: number): string => (c / 100).toFixed(2);
