// A tiny h + renderer for widget tests: enough to turn views into text for assertions.
export const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });

export function text(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node.type === 'function') return text(node.type({ ...node.props, children: node.children }));
  return `<${node.type}>${node.children.map(text).join('')}</${node.type}>`;
}
