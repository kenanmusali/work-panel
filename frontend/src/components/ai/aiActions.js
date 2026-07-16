// aiActions.js
// Turns a raw action object from the model into something a human can read
// before approving it. Nothing here executes — Home.jsx / Diagram.jsx own the
// actual mutations, this only decides what the confirm popup says.

function groupName(ctx, id) {
  const g = (ctx?.groups || []).find(x => Number(x.id) === Number(id));
  return g ? `"${g.name}"` : `#${id}`;
}
function procName(ctx, id) {
  const all = [...(ctx?.processes || []), ...(ctx?.archived || [])];
  const p = all.find(x => Number(x.id) === Number(id));
  return p ? `"${p.title}"` : `#${id}`;
}
function nodeName(ctx, id) {
  const n = (ctx?.diagram?.nodes || []).find(x => String(x.id) === String(id));
  return n ? `#${id} "${(n.text || '').slice(0, 40)}"` : `#${id}`;
}
function laneName(ctx, id) {
  const l = (ctx?.diagram?.lanes || []).find(x => String(x.id) === String(id));
  return l ? `"${l.label}"` : `${id}`;
}
function specSummary(a) {
  const lanes = a.lanes?.length || 0;
  const nodes = a.nodes?.length || 0;
  const edges = a.edges?.length || 0;
  return `${lanes} panel, ${nodes} node, ${edges} əlaqə`;
}

/**
 * -> { title, detail, danger, icon }
 * `danger: true` makes the popup red and forces a deliberate confirm.
 */
export function describeAction(a, ctx) {
  switch (a.type) {
    case 'create_group':
      return {
        title: 'Yeni qovluq yarat',
        detail: `"${a.name}"` + (a.parentId ? ` — ${groupName(ctx, a.parentId)} qovluğunun içində` : ' — əsas siyahıda'),
        icon: 'folder'
      };
    case 'rename_group':
      return {
        title: 'Qovluğun adını dəyiş',
        detail: `${groupName(ctx, a.groupId)} → "${a.name}"`,
        icon: 'edit'
      };
    case 'delete_group':
      return {
        title: 'Qovluğu sil',
        detail: `${groupName(ctx, a.groupId)} — alt qovluqları və içindəki diaqramlarla birlikdə silinəcək.`,
        danger: true, icon: 'trash'
      };
    case 'create_diagram':
      return {
        title: 'Yeni diaqram yarat',
        detail: `"${a.title}"${a.subtitle ? ` (${a.subtitle})` : ''} — ${groupName(ctx, a.groupId)} qovluğunda.\n${specSummary(a)} qurulacaq və açılacaq.`,
        icon: 'plus'
      };
    case 'generate_diagram':
      return {
        title: 'Diaqramı yenidən qur',
        detail: `${specSummary(a)}.\nDİQQƏT: hazırkı bütün panel, node və əlaqələr əvəz olunacaq. "Yadda saxla"ya basmayana qədər serverə yazılmır — Ctrl+Z ilə geri ala bilərsiniz.`,
        danger: true, icon: 'sparkles'
      };
    case 'rename_diagram':
      return {
        title: 'Diaqramı yenilə',
        detail: `${procName(ctx, a.processId)}\n` + [
          a.title != null ? `ad → "${a.title}"` : null,
          a.subtitle != null ? `alt ad → "${a.subtitle}"` : null,
          a.groupId != null ? `qovluq → ${groupName(ctx, a.groupId)}` : null
        ].filter(Boolean).join('\n'),
        icon: 'edit'
      };
    case 'archive_diagram':
      return {
        title: 'Arxivə köçür',
        detail: a.processId != null ? procName(ctx, a.processId) : `"${ctx?.diagram?.title || 'bu diaqram'}"`,
        icon: 'archive'
      };
    case 'unarchive_diagram':
      return { title: 'Arxivdən çıxar', detail: procName(ctx, a.processId), icon: 'archive' };
    case 'delete_diagram':
      return {
        title: 'Diaqramı sil',
        detail: `${procName(ctx, a.processId)} — geri alına bilməz.`,
        danger: true, icon: 'trash'
      };
    case 'open_diagram':
      return { title: 'Diaqramı aç', detail: procName(ctx, a.processId), icon: 'open' };
    case 'filter':
      return { title: 'Axtarışda filtrlə', detail: `"${a.query}"`, icon: 'search' };
    case 'add_lane':
      return { title: 'Panel əlavə et', detail: `"${a.label}"`, icon: 'plus' };
    case 'delete_lane':
      return {
        title: 'Paneli sil',
        detail: `${laneName(ctx, a.laneId)} — içindəki node-lar da silinəcək.`,
        danger: true, icon: 'trash'
      };
    case 'add_node':
      return {
        title: 'Node əlavə et',
        detail: `"${a.text}" (${a.shape || 'rect'} / ${a.style || 'solid'}) — ${a.lane ? `"${a.lane}"` : 'aktiv'} panelinə`,
        icon: 'plus'
      };
    case 'update_node':
      return {
        title: 'Node-u dəyiş',
        detail: `${nodeName(ctx, a.nodeId)}\n` + [
          a.text != null ? `mətn → "${a.text}"` : null,
          a.shape ? `forma → ${a.shape}` : null,
          a.style ? `stil → ${a.style}` : null,
          a.general ? 'ümumi məlumat yenilənir' : null,
          a.risks ? 'risklər yenilənir' : null
        ].filter(Boolean).join('\n'),
        icon: 'edit'
      };
    case 'delete_node':
      return {
        title: 'Node-u sil',
        detail: `${nodeName(ctx, a.nodeId)} — ona bağlı oxlar da silinəcək.`,
        danger: true, icon: 'trash'
      };
    case 'add_edge':
      return {
        title: 'Ox əlavə et',
        detail: `${nodeName(ctx, a.from)} → ${nodeName(ctx, a.to)}${a.label ? ` ("${a.label}")` : ''}`,
        icon: 'arrow'
      };
    case 'delete_edge':
      return {
        title: 'Oxu sil',
        detail: `${nodeName(ctx, a.from)} → ${nodeName(ctx, a.to)}`,
        danger: true, icon: 'trash'
      };
    case 'set_title':
      return {
        title: 'Başlığı dəyiş',
        detail: [a.title ? `ad → "${a.title}"` : null, a.subtitle != null ? `alt ad → "${a.subtitle}"` : null]
          .filter(Boolean).join('\n'),
        icon: 'edit'
      };
    case 'relayout':
      return { title: 'Yerləşməni səliqəyə sal', detail: 'Panellər node-lara uyğun yenidən yığışdırılacaq.', icon: 'sparkles' };
    case 'save':
      return { title: 'Yadda saxla', detail: 'Dəyişikliklər serverə yazılacaq.', icon: 'save' };
    case 'present':
      return { title: 'Təqdimat rejimi', detail: 'Addımlar avtomatik göstəriləcək.', icon: 'play' };
    case 'logout':
      return {
        title: 'Sistemdən çıx',
        detail: 'Yadda saxlanmamış dəyişikliklər itə bilər.',
        danger: true, icon: 'logout'
      };
    default:
      return { title: a.type, detail: JSON.stringify(a, null, 1).slice(0, 400), icon: 'sparkles' };
  }
}
