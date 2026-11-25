// Async function body run inside the desktop app by `desktop.sh seed-demo`.
// Replays the mock backend's demo seed through the real API so the browser
// journeys (which assume those pages) can run against the real backend.
const M = window.__MINOTES__.modules;
if (!M) throw new Error("this build does not expose __MINOTES__.modules");
const api = M["/src/lib/api.ts"], mock = M["/src/lib/mockBackend.ts"].mockHandlers;
let pages = 0, blocks = 0;
for (const p of mock.list_pages({limit: 1000})) {
  if (p.is_journal) continue;
  const tree = mock.get_page_tree({titleOrId: p.id});
  let real = (await api.listPages(1000)).find(x => x.title === p.title);
  if (real) { for (const b of (await api.getPageTree(real.id)).blocks.filter(b => !b.parent_id)) await api.deleteBlock(b.id); }
  else { real = await api.createPage(p.title); pages++; }
  const idMap = new Map();
  for (const b of [...tree.blocks].sort((a, b) => a.position - b.position)) {
    const nb = await api.createBlock(real.id, b.content, b.parent_id ? idMap.get(b.parent_id) : undefined);
    idMap.set(b.id, nb.id); blocks++;
  }
}
// The mock starts on today's journal with a starter block; the real app starts
// on Getting Started with no journal yet. Match the mock's starting state.
const T = window.__MINOTES__;
T.openJournal();
let journal = null;
for (let i = 0; i < 40 && !journal; i++) {
  await new Promise(r => setTimeout(r, 250));
  journal = (await api.listPages(1000)).find(x => x.is_journal);
  if (!journal && i % 8 === 7) { T.setBlockContent && T.setBlockContent(0, ""); T.openJournal(); }
}
const mj = mock.list_pages({limit: 1000}).find(p => p.is_journal);
if (!journal && mj) {
  // Past-date journals are soft-created; today's is created on first write.
  const tree = mock.get_page_tree({titleOrId: mj.id});
  journal = await api.createPage(mj.title);
  for (const b of tree.blocks) { await api.createBlock(journal.id, b.content); blocks++; }
} else if (journal && mj && (await api.getPageTree(journal.id)).blocks.length === 0) {
  for (const b of mock.get_page_tree({titleOrId: mj.id}).blocks) { await api.createBlock(journal.id, b.content); blocks++; }
}
T.refreshSidebar && T.refreshSidebar();
T.openJournal();
return {pagesCreated: pages, blocksCreated: blocks, journal: journal && journal.title};
