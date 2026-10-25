// Small DOM toolkit shared by the webviews: element builder, messaging, context menu and picker popup.

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

export function post<T>(message: T): void {
  vscode.postMessage(message);
}

export function onMessage<T>(handler: (message: T) => void): void {
  window.addEventListener('message', (e: MessageEvent) => handler(e.data as T));
}

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

/** Creates an element. Props: class, title, style, dataset, on<Event> handlers; anything else becomes an attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/** replaceChildren that skips null/false children. */
export function setChildren(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function icon(name: string, extraClass = ''): HTMLElement {
  return h('span', { class: `codicon codicon-${name} ${extraClass}`.trim() });
}

export function button(label: string, onClick: () => void, opts: { icon?: string; title?: string; secondary?: boolean; class?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      class: ['btn', opts.secondary && 'secondary', !label && 'icon-only', opts.class].filter(Boolean).join(' '),
      title: opts.title ?? label,
      onclick: onClick,
    },
    opts.icon ? icon(opts.icon) : null,
    label ? h('span', null, label) : null,
  );
}

// ---- Context menu --------------------------------------------------------

export type MenuItem = { label: string; icon?: string; action: () => void; disabled?: boolean } | 'separator';

let openMenu: HTMLElement | undefined;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = undefined;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = h(
    'div',
    { class: 'context-menu', role: 'menu' },
    ...items.map((item) =>
      item === 'separator'
        ? h('div', { class: 'menu-separator' })
        : h(
            'div',
            {
              class: `menu-item${item.disabled ? ' disabled' : ''}`,
              role: 'menuitem',
              onclick: () => {
                if (item.disabled) return;
                closeMenu();
                item.action();
              },
            },
            item.icon ? icon(item.icon) : h('span', { class: 'codicon' }),
            h('span', null, item.label),
          ),
    ),
  );
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  openMenu = menu;
}

// ---- Picker popup (filter dropdowns) -------------------------------------

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface PickerOptions {
  items: PickerItem[];
  selected: string[];
  multi: boolean;
  placeholder: string;
  onChange: (values: string[]) => void;
}

let openPicker: HTMLElement | undefined;

export function closePicker(): void {
  openPicker?.remove();
  openPicker = undefined;
}

export function showPicker(anchor: HTMLElement, opts: PickerOptions): void {
  closePicker();
  closeMenu();
  const selected = new Set(opts.selected);
  const input = h('input', { class: 'picker-filter', placeholder: opts.placeholder, type: 'text' });
  const list = h('div', { class: 'picker-list' });

  const render = () => {
    const q = input.value.toLowerCase();
    list.replaceChildren(
      ...opts.items
        .filter((it) => !q || it.label.toLowerCase().includes(q) || it.description?.toLowerCase().includes(q))
        .slice(0, 300)
        .map((it) =>
          h(
            'div',
            {
              class: `picker-item${selected.has(it.value) ? ' selected' : ''}`,
              title: it.description ? `${it.label} ${it.description}` : it.label,
              onclick: () => {
                if (opts.multi) {
                  if (selected.has(it.value)) selected.delete(it.value);
                  else selected.add(it.value);
                  opts.onChange([...selected]);
                  render();
                } else {
                  closePicker();
                  opts.onChange([it.value]);
                }
              },
            },
            opts.multi ? icon(selected.has(it.value) ? 'check' : 'blank') : it.icon ? icon(it.icon) : null,
            h('span', { class: 'picker-label' }, it.label),
            it.description ? h('span', { class: 'picker-desc' }, it.description) : null,
          ),
        ),
    );
  };

  const footer = opts.multi
    ? h(
        'div',
        { class: 'picker-footer' },
        button('Clear', () => {
          selected.clear();
          opts.onChange([]);
          render();
        }, { secondary: true }),
        button('Done', closePicker),
      )
    : null;

  const popup = h('div', { class: 'picker' }, input, list, footer);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
    if (e.key === 'Enter' && !opts.multi) (list.firstElementChild as HTMLElement | null)?.click();
  });
  render();
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - popup.offsetWidth - 4))}px`;
  popup.style.top = `${r.bottom + 2}px`;
  openPicker = popup;
  input.focus();
}

document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  if (openMenu && !openMenu.contains(target)) closeMenu();
  if (openPicker && !openPicker.contains(target)) closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    closePicker();
  }
});
window.addEventListener('blur', () => {
  closeMenu();
  closePicker();
});

/** Makes a vertical splitter resize a fixed-width pane on its left (or right) side. */
export function makeSplitter(splitter: HTMLElement, target: HTMLElement, side: 'left' | 'right', min = 120): void {
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = target.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) * (side === 'left' ? 1 : -1);
      target.style.width = `${Math.max(min, startWidth + delta)}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

export function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${time}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
