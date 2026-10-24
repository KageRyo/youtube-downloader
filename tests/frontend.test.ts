import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function page(overrides: Record<string, any> = {}) {
  const elements = new Map<string, any>();
  const element = () => ({ textContent: '', innerHTML: '', style: {}, dataset: {}, value: '', children: [] as any[], classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); }, addEventListener() {} });
  const context: any = { document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelectorAll: () => [], documentElement: {} , createElement: element }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, FormData, window: { addEventListener() {}, setTimeout() {} }, console, ...overrides };
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

describe('download task management', () => {
  it('retries only failed URL-format pairs and keeps original settings', () => {
    const app = page();
    const result = app.run(`(() => { const original = new FormData(); original.set('quality','720'); original.set('urls','secret'); original.append('format','mp3'); original.append('format','mp4'); const data = buildRetryData({items:[{url:'a',format:'mp3',status:'completed'},{url:'a',format:'mp4',status:'failed'},{url:'b',format:'mp3',status:'failed'}]}, original); return {items:JSON.parse(data.get('items')), quality:data.get('quality')}; })()`);
    expect(result.items).toEqual([{url:'a',format:'mp4'},{url:'b',format:'mp3'}]);
    expect(result.quality).toBe('720');
  });
  it('stores only validated job UUIDs, never summary URLs, titles, or errors', () => {
    const app = page();
    expect(app.run(`persistedJobIds([{id:'123e4567-e89b-42d3-a456-426614174000',items:[{url:'secret'}]}, {id:'bad'}])`)).toEqual(['123e4567-e89b-42d3-a456-426614174000']);
  });
  it('renders failed item diagnostics as text and successful download links for partial jobs', () => {
    const app = page();
    app.run(`renderTaskPanel([{id:'job',status:'completed',items:[{id:'ok',format:'mp3',status:'completed',downloadName:'ok.mp3'},{id:'bad',format:'mp4',status:'failed',error:'<img onerror=alert(1)>'}]}])`);
    const panel = app.elements.get('taskList');
    function descendants(node: any): any[] {
      return [node, ...node.children.flatMap(descendants)];
    }
    const nodes = descendants(panel);
    expect(nodes.filter((node) => node.textContent === '<img onerror=alert(1)>')).toHaveLength(1);
    expect(nodes.every((node) => node.innerHTML === '')).toBe(true);
    expect(nodes.some((node) => node.href === '/api/download/job/items/ok/file')).toBe(true);
  });
});


it('recovers UUID-only jobs, stops on expiry, and retains no submitted URLs', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const requests: string[] = [];
  const app = page({ sessionStorage: {getItem: () => JSON.stringify([id, 'invalid']), setItem() {}}, fetch: async (url: string) => { requests.push(url); return {status:404}; } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(requests).toEqual([`/api/download/${id}`]);
  expect(app.run(`tasks.get('${id}').status`)).toBe('expired');
  expect(app.elements.get('urls').value).toBe('');
});

it('ignores in-flight polling responses after a cancellation request', async () => {
  let finishPoll: (value: any) => void = () => {};
  const app = page({fetch: (url: string, options: any) => options?.method === 'POST' ? Promise.resolve({ok:true}) : new Promise((resolve) => { finishPoll = resolve; })});
  app.run(`tasks.set('job', {id:'job', status:'running', items:[]}); void pollTask('job');`);
  await app.run(`cancelTask('job')`);
  finishPoll({status:200,ok:true,json:async () => ({id:'job',status:'completed',items:[]})});
  await new Promise((resolve) => setImmediate(resolve));
  expect(app.run(`tasks.get('job').status`)).toBe('running');
});

it('a poll from an older job does not overwrite a newer job progress', async () => {
  let finishPoll: (value: any) => void = () => {};
  const app = page({fetch: () => new Promise((resolve) => { finishPoll = resolve; })});
  app.run(`tasks.set('old', {id:'old',status:'running',items:[]}); void pollTask('old'); activeJobId='new'; updateTask({id:'new',status:'running',items:[],progress:{stage:'running',percent:75}});`);
  finishPoll({status:200,ok:true,json:async () => ({id:'old',status:'completed',items:[]})});
  await new Promise((resolve) => setImmediate(resolve));
  expect(app.elements.get('status').textContent).toContain('Overall 75.0%');
});

it('retries a failed caption using its exact language and source', () => {
  const app = page();
  const result = app.run(`(() => { const original = new FormData(); original.set('subtitleLanguages','en,zh-Hant'); original.set('subtitleSource','automatic'); return JSON.parse(buildRetryData({items:[{url:'a',format:'vtt',subtitleLanguage:'en',subtitleSource:'automatic',status:'completed'},{url:'a',format:'vtt',subtitleLanguage:'zh-Hant',subtitleSource:'automatic',status:'failed'}]},original).get('items')); })()`);
  expect(result).toEqual([{url:'a',format:'vtt',subtitleLanguage:'zh-Hant',subtitleSource:'automatic'}]);
});
