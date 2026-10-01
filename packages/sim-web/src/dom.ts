// Small DOM helpers so the UI is built from text nodes and typed element creation, never from an HTML
// string. Nothing user- or server-provided is ever assigned as markup, so there is no HTML-injection
// surface and the strict CSP needs no inline anything (see the generated policy and _headers).

type Attrs = Record<string, string>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string; attrs?: Attrs } = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className !== undefined) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs !== undefined) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: Element, value: string): void {
  node.textContent = value;
}

/** Query one element by selector, asserting it exists. Used only for the fixed app shell. */
export function must<T extends Element>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector);
  if (node === null) throw new Error(`missing element: ${selector}`);
  return node;
}
