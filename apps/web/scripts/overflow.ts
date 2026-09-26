// Pixels any box reaches past the viewport sides, which body clipping and mobile emulation hide from scroll width
export const HORIZONTAL_OVERFLOW = `(() => {
  const width = document.documentElement.clientWidth;
  let overflow = 0;
  for (const element of document.querySelectorAll('body *')) {
    // A closed details element still lays out its content, unrendered
    if (!element.checkVisibility({ visibilityProperty: true })) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    overflow = Math.max(overflow, rect.right - width, -rect.left);
  }
  return Math.round(overflow);
})()`;
