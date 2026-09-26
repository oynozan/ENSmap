// Pixels any box reaches past the viewport sides, which body clipping and mobile emulation hide from scroll width
export const HORIZONTAL_OVERFLOW = `(() => {
  const width = document.documentElement.clientWidth;
  let overflow = 0;
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    overflow = Math.max(overflow, rect.right - width, -rect.left);
  }
  return Math.round(overflow);
})()`;
