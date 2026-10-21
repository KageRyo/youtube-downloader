import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function page() {
  const elements = new Map<string, any>();
  const element = () => ({ textContent: '', innerHTML: '', style: {}, dataset: {}, value: '', children: [] as any[], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, appendChild(child: any) { this.children.push(child); }, addEventListener() {} });
  const context: any = { document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelectorAll: () => [], documentElement: {} , createElement: element }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, window: { addEventListener() {}, setTimeout() {} }, console };
  runInNewContext(readFileSync('public/app.js', 'utf8'), context);
  return { elements, run: (code: string) => runInNewContext(code, context) };
}

describe('localized progress', () => {
  it('renders structured progress and rerenders the running job when switching language', () => {
    const app = page();
    app.run(`renderJobProgress({ status: 'running', message: '不要顯示', progress: {stage: 'running', detail: 'downloading media', current: 1, total: 2, percent: 25, itemPercent: 50} });`);
    expect(app.elements.get('status').textContent).toBe('Downloading (1/2) | Overall 25.0% | Current file 50.0%');
    app.run(`setLocale('zh-Hant')`);
    expect(app.elements.get('status').textContent).toContain('整體 25.0%');
    expect(app.elements.get('status').textContent).not.toContain('downloading media');
  });
  it('uses translated fallback for unknown stages without leaking backend detail', () => {
    const app = page();
    app.run(`renderJobProgress({ status: 'running', message: 'raw', progress: {stage: 'future-stage', detail: 'raw detail'} });`);
    expect(app.elements.get('status').textContent).toContain('Processing on the server');
    expect(app.elements.get('status').textContent).not.toContain('raw');
  });
});
