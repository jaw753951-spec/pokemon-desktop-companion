/**
 * Tiny DOM helpers.
 *
 * The UI is plain elements rather than a framework: the screens are small, the
 * pixel-art styling is all CSS, and this keeps the renderer dependency-free.
 */

/**
 * @param {string} tag `div`, or `div.class.other`, or `span.class#id` — the
 *   `#id` may appear anywhere after the tag name
 * @param {Record<string, any>|null} [props] attributes; `onClick` binds a listener,
 *   `text` sets textContent, `style` merges into the inline style
 * @param {Array<Node|string|null|undefined|false>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = null, children = []) {
  const hash = tag.indexOf('#');
  const id = hash >= 0 ? tag.slice(hash + 1).split('.')[0] : '';
  const withoutId = hash >= 0 ? tag.slice(0, hash) + tag.slice(hash + 1 + id.length) : tag;
  const [name, ...classes] = withoutId.split('.');

  const node = document.createElement(name || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.filter(Boolean).join(' ');

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'style') applyStyle(node, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (!child) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Merge a style object into an element.
 *
 * Assigning the object wholesale drops anything whose name is not a DOM style
 * property — a custom property such as `--badge-art`, or a prefixed one such
 * as `-webkit-app-region` — silently, leaving the rule that reads it invalid.
 * Anything hyphenated therefore goes through `setProperty`, which takes CSS
 * names as written.
 *
 * @param {HTMLElement} node
 * @param {Record<string, string>} styles
 */
function applyStyle(node, styles) {
  for (const [key, value] of Object.entries(styles)) {
    if (key.includes('-')) node.style.setProperty(key, value);
    else node.style[key] = value;
  }
}

/** @param {HTMLElement} node */
export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * Replace a node's children, dropping the empty ones.
 *
 * `replaceChildren` stringifies a `null` argument into the text "null", so a
 * conditionally-rendered child written as `condition ? el(...) : null` would
 * otherwise print the word. This filters first, matching how `el` treats its
 * own children.
 *
 * @param {HTMLElement} node
 * @param {Array<Node|string|null|undefined|false>} children
 */
export function setChildren(node, children) {
  const kept = /** @type {Array<Node|string>} */ (children.filter(Boolean));
  node.replaceChildren(...kept);
  return node;
}

/**
 * A button that also responds to Enter and Space, and never drags the window.
 * @param {string} label
 * @param {() => void} onSelect
 * @param {{className?: string, disabled?: boolean, title?: string}} [options]
 */
export function button(label, onSelect, options = {}) {
  return el(
    `button.btn${options.className ? `.${options.className}` : ''}`,
    {
      type: 'button',
      text: label,
      disabled: options.disabled ?? false,
      title: options.title ?? null,
      onClick: () => {
        if (!options.disabled) onSelect();
      },
    },
  );
}

/**
 * Make a container scroll with the mouse wheel even where the pointer is over a
 * child, and show it only when the content overflows.
 * @param {HTMLElement} node
 */
export function scrollable(node) {
  node.classList.add('scroll');
  node.addEventListener(
    'wheel',
    (event) => {
      if (node.scrollHeight <= node.clientHeight) return;
      node.scrollTop += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
  return node;
}

/**
 * The mark a shiny Pokémon is shown with.
 *
 * The red star the games' summary screens put beside a shiny, from Diamond and
 * Pearl through Sun and Moon.
 */
export const SHINY_MARK = '★';

/**
 * That mark as an element, for the screens that list Pokémon.
 *
 * @param {{shiny?: boolean}|null|undefined} pokemon
 * @returns {HTMLElement|null} nothing at all for an ordinary Pokémon
 */
export function shinyMark(pokemon) {
  if (!pokemon?.shiny) return null;
  return el('span.shiny-mark', { text: SHINY_MARK });
}

/**
 * The status condition beside a name, as the games show it: a small coloured
 * tag with the condition's short name — yellow for paralysis, purple for
 * poison, and so on.
 *
 * @param {string|null|undefined} status `brn`, `psn`, `par`, `slp` or `frz`
 * @param {string} label the condition's short name in the player's language
 * @returns {HTMLElement|null} nothing for a healthy Pokémon
 */
export function statusMark(status, label) {
  if (!status) return null;
  return el(`span.status-mark.${status}`, { text: label });
}
