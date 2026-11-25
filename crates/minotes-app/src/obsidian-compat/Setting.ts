export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement('div');
    this.settingEl.className = 'setting-item';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div');
    this.descEl.className = 'setting-item-description';
    this.controlEl = document.createElement('div');
    this.controlEl.className = 'setting-item-control';

    const info = document.createElement('div');
    info.className = 'setting-item-info';
    info.append(this.nameEl, this.descEl);
    this.settingEl.append(info, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }

  setName(name: string): this { this.nameEl.textContent = name; return this; }
  setDesc(desc: string): this { this.descEl.textContent = desc; return this; }
  setClass(cls: string): this { this.settingEl.classList.add(cls); return this; }

  addToggle(cb: (toggle: Toggle) => void): this {
    const toggle = new Toggle(this.controlEl);
    cb(toggle);
    return this;
  }

  addText(cb: (text: TextComponent) => void): this {
    const text = new TextComponent(this.controlEl);
    cb(text);
    return this;
  }

  addTextArea(cb: (ta: TextAreaComponent) => void): this {
    const ta = new TextAreaComponent(this.controlEl);
    cb(ta);
    return this;
  }

  addDropdown(cb: (dd: DropdownComponent) => void): this {
    const dd = new DropdownComponent(this.controlEl);
    cb(dd);
    return this;
  }

  addButton(cb: (btn: ButtonComponent) => void): this {
    const btn = new ButtonComponent(this.controlEl);
    cb(btn);
    return this;
  }

  addSlider(cb: (slider: SliderComponent) => void): this {
    const slider = new SliderComponent(this.controlEl);
    cb(slider);
    return this;
  }
}

class Toggle {
  private el: HTMLInputElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('input');
    this.el.type = 'checkbox';
    container.appendChild(this.el);
  }
  setValue(val: boolean): this { this.el.checked = val; return this; }
  onChange(cb: (val: boolean) => void): this { this.el.addEventListener('change', () => cb(this.el.checked)); return this; }
}

class TextComponent {
  private el: HTMLInputElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('input');
    this.el.type = 'text';
    container.appendChild(this.el);
  }
  setValue(val: string): this { this.el.value = val; return this; }
  setPlaceholder(p: string): this { this.el.placeholder = p; return this; }
  onChange(cb: (val: string) => void): this { this.el.addEventListener('change', () => cb(this.el.value)); return this; }
  getValue(): string { return this.el.value; }
}

class TextAreaComponent {
  private el: HTMLTextAreaElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('textarea');
    container.appendChild(this.el);
  }
  setValue(val: string): this { this.el.value = val; return this; }
  setPlaceholder(p: string): this { this.el.placeholder = p; return this; }
  onChange(cb: (val: string) => void): this { this.el.addEventListener('change', () => cb(this.el.value)); return this; }
}

class DropdownComponent {
  private el: HTMLSelectElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('select');
    container.appendChild(this.el);
  }
  addOption(value: string, display: string): this {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = display;
    this.el.appendChild(opt);
    return this;
  }
  setValue(val: string): this { this.el.value = val; return this; }
  onChange(cb: (val: string) => void): this { this.el.addEventListener('change', () => cb(this.el.value)); return this; }
}

class ButtonComponent {
  private el: HTMLButtonElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('button');
    container.appendChild(this.el);
  }
  setButtonText(text: string): this { this.el.textContent = text; return this; }
  setCta(): this { this.el.classList.add('mod-cta'); return this; }
  setWarning(): this { this.el.classList.add('mod-warning'); return this; }
  onClick(cb: () => void): this { this.el.addEventListener('click', cb); return this; }
}

class SliderComponent {
  private el: HTMLInputElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('input');
    this.el.type = 'range';
    container.appendChild(this.el);
  }
  setLimits(min: number, max: number, step: number): this {
    this.el.min = String(min); this.el.max = String(max); this.el.step = String(step);
    return this;
  }
  setValue(val: number): this { this.el.value = String(val); return this; }
  onChange(cb: (val: number) => void): this { this.el.addEventListener('input', () => cb(Number(this.el.value))); return this; }
}
