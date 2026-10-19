(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeLink = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  };

  // Deliberately small Markdown dialect. Every leaf is escaped; raw HTML/images
  // are never executable. Unsupported syntax remains readable text.
  function inline(source, depth = 0) {
    if (depth > 5) return escape(source);
    let out = '', i = 0;
    while (i < source.length) {
      const rest = source.slice(i);
      if (source[i] === '\\' && /[\\`*_[\]{}()#+.!|>-]/.test(source[i + 1] || '')) { out += escape(source[i + 1]); i += 2; continue; }
      if (source[i] === '`') {
        const ticks = /^`+/.exec(rest)[0], end = source.indexOf(ticks, i + ticks.length);
        if (end > i + ticks.length) { out += '<code>' + escape(source.slice(i + ticks.length, end)) + '</code>'; i = end + ticks.length; continue; }
      }
      const link = /^(!?)\[([^\]\n]+)\]\(([^\s()]+)\)/.exec(rest);
      if (link) {
        const href = safeLink(link[3]);
        out += link[1] ? escape(link[2]) : href ? '<a href="' + escape(href) + '" target="_blank" rel="noopener noreferrer">' + inline(link[2], depth + 1) + '</a>' : escape(link[0]);
        i += link[0].length; continue;
      }
      const delimiter = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : source[i] === '*' ? '*' : null;
      if (delimiter) {
        const end = source.indexOf(delimiter, i + delimiter.length);
        if (end > i + delimiter.length && !/^\s|\s$/.test(source.slice(i + delimiter.length, end))) {
          const tag = delimiter.length === 2 ? 'strong' : 'em';
          out += '<' + tag + '>' + inline(source.slice(i + delimiter.length, end), depth + 1) + '</' + tag + '>'; i = end + delimiter.length; continue;
        }
      }
      out += escape(source[i++]);
    }
    return out;
  }
  function cells(line) {
    line = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    const parts = []; let part = '', code = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && line[i + 1] === '|') { part += '\\|'; i++; }
      else if (line[i] === '`') { code = !code; part += line[i]; }
      else if (line[i] === '|' && !code) { parts.push(part.trim()); part = ''; }
      else part += line[i];
    }
    parts.push(part.trim()); return parts;
  }
  const listItem = line => /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  const heading = line => /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
  const fence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const rule = line => /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line);
  const divider = line => line.includes('|') && cells(line).every(x => /^:?-{3,}:?$/.test(x));
  const isTable = (lines, i) => !!lines[i + 1] && lines[i].includes('|') && divider(lines[i + 1]) && cells(lines[i]).length === cells(lines[i + 1]).length;
  function blocks(lines, depth = 0) {
    if (depth > 8) return '<p>' + lines.map(escape).join('<br>') + '</p>';
    let out = '', i = 0;
    const startsBlock = n => !lines[n]?.trim() || heading(lines[n]) || fence(lines[n]) || rule(lines[n]) || /^ {0,3}>/.test(lines[n]) || listItem(lines[n]) || isTable(lines, n);
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      let match;
      if ((match = fence(lines[i]))) {
        const marker = match[1], body = []; i++;
        while (i < lines.length && !new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        out += '<pre><code>' + escape(body.join('\n')) + '</code></pre>'; continue;
      }
      if ((match = heading(lines[i]))) { const level = Math.min(5, Math.max(3, match[1].length)); out += '<h' + level + '>' + inline(match[2]) + '</h' + level + '>'; i++; continue; }
      if (rule(lines[i])) { out += '<hr>'; i++; continue; }
      if (isTable(lines, i)) {
        const headers = cells(lines[i]), aligns = cells(lines[i + 1]).map(x => x.endsWith(':') ? x.startsWith(':') ? 'center' : 'right' : 'left'); i += 2;
        const cell = (value, index, tag) => '<' + tag + (tag === 'th' ? ' scope="col"' : '') + ' class="reply-align-' + aligns[index] + '">' + inline(value) + '</' + tag + '>';
        out += '<div class="reply-table-scroll" role="region" aria-label="回复中的表格，可横向滚动" tabindex="0"><table><thead><tr>' + headers.map((v, n) => cell(v, n, 'th')).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !startsNonTableBlock(lines[i])) {
          const row = cells(lines[i++]); out += '<tr>' + headers.map((_, n) => cell(row[n] || '', n, 'td')).join('') + '</tr>';
        }
        out += '</tbody></table></div>'; continue;
      }
      if (/^ {0,3}>/.test(lines[i])) {
        const quoted = []; while (i < lines.length && /^ {0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        out += '<blockquote>' + blocks(quoted, depth + 1) + '</blockquote>'; continue;
      }
      if ((match = listItem(lines[i]))) {
        const indent = match[1].length, ordered = /^\d/.test(match[2]), tag = ordered ? 'ol' : 'ul';
        out += '<' + tag + (ordered ? ' start="' + Number.parseInt(match[2], 10) + '"' : '') + '>';
        while (i < lines.length) {
          const item = listItem(lines[i]);
          if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
          const body = [item[3]], strip = indent + item[2].length + 1; i++;
          while (i < lines.length) {
            if (!lines[i].trim()) {
              if (i + 1 < lines.length && lines[i + 1].search(/\S/) > indent) { body.push(''); i++; continue; }
              break;
            }
            if (lines[i].search(/\S/) <= indent) break;
            const line = lines[i++]; body.push(line.slice(Math.min(strip, line.search(/\S/))));
          }
          out += '<li>' + blocks(body, depth + 1) + '</li>';
          if (i < lines.length && !lines[i].trim() && listItem(lines[i + 1] || '')) i++;
        }
        out += '</' + tag + '>'; continue;
      }
      const paragraph = [lines[i++]];
      while (i < lines.length && !startsBlock(i)) paragraph.push(lines[i++]);
      out += '<p>' + paragraph.map(line => inline(line)).join('<br>') + '</p>';
    }
    return out;
  }
  function startsNonTableBlock(line) { return heading(line) || fence(line) || /^ {0,3}>/.test(line) || listItem(line); }
  function markdown(value) { return blocks(String(value ?? '').replace(/\r\n?/g, '\n').split('\n')); }
  function body(value, cards = '') {
    const prose = markdown(value), end = cards && prose.startsWith('<p>') ? prose.indexOf('</p>') + 4 : 0;
    const wrap = (html, detail = false) => html ? '<div class="message-text reply-prose' + (detail ? ' reply-detail' : '') + '">' + html + '</div>' : '';
    // Place supporting facts immediately after the answer, before long advice.
    return end ? wrap(prose.slice(0, end)) + cards + wrap(prose.slice(end), true) : wrap(prose) + cards;
  }

  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  function blockHtml(block, helpers) {
    const {action, scopeLabel, time} = helpers;
    const context = block.context || {}, stamp = block.captured_at ? time(block.captured_at) : '';
    const meta = '<p class="reply-card-meta">查询时快照' + (stamp ? ' · ' + escape(stamp) : '') + ' · ' + escape(scopeLabel(context)) + '</p>';
    if (block.type === 'metrics' && block.data) {
      const d = block.data, c = d.counts || {}, rate = typeof d.l3_delivery_rate === 'number' && Number.isFinite(d.l3_delivery_rate) && d.l3_delivery_rate >= 0 && d.l3_delivery_rate <= 1 ? (d.l3_delivery_rate * 100).toFixed(1) + '%' : '—';
      return '<section class="reply-card" aria-label="关键数据"><div class="reply-card-heading"><h3>关键数据</h3>' + action({type:'analytics', label:'查看数据分析', context}) + '</div>' + meta + '<dl class="reply-metrics">' + [['有效记录', count(d.valid)], ['已执行评级', count(d.evaluated)], ['L3 可交付率', rate]].map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>').join('') + '</dl><p class="reply-denominator">L3 ' + count(c.L3) + ' 条 / 可评价 ' + count(d.evaluable) + ' 条' + (rate === '—' ? ' · 尚无可评价记录' : '') + '</p><ul class="reply-status-counts">' + [['U · 无法判断', c.U], ['待匹配', c.routing_pending], ['待评', c.pending], ['评级中', c.running], ['评级失败', c.failed], ['导入失败', c.import_failed]].filter(([, n]) => n > 0).map(([label, value]) => '<li>' + label + ' <b>' + count(value) + '</b></li>').join('') + '</ul></section>';
    }
    if (block.type === 'analysis_tasks' && Array.isArray(block.tasks)) {
      const row = task => {
        const run = task.latest_run?.[0], status = run ? ({running:'评级中', completed:'评级已完成', completed_with_errors:'评级部分失败', interrupted:'评级已中断'}[run.status] || '已有评级结果') : task.confirmed === true ? '方案已确认，待评级' : task.confirmed === false ? '待确认方案' : '方案确认状态待核对';
        const progress = run && Number.isSafeInteger(run.total) && run.total > 0 && Number.isSafeInteger(run.processed_count) && run.processed_count >= 0 ? '<div class="reply-progress"><progress max="' + run.total + '" value="' + Math.min(run.processed_count, run.total) + '" aria-label="' + escape(task.name) + '评级进度"></progress><span>' + run.processed_count + ' / ' + run.total + '</span></div>' : '';
        return '<li class="reply-task"><div class="reply-task-title"><strong>' + escape(task.name) + '</strong><span class="reply-task-state">' + status + '</span></div><p>有效记录 ' + count(task.imported_count) + ' 条' + (task.import_failed > 0 ? ' · 导入失败 ' + count(task.import_failed) + ' 行' : '') + (run?.failed_count > 0 ? ' · 评级失败 ' + count(run.failed_count) + ' 条' : '') + '</p>' + progress + action({type:'batch', id:task.id, label:'查看任务'}) + '</li>';
      };
      const tasks = block.tasks;
      return '<section class="reply-card" aria-label="分析任务进展"><div class="reply-card-heading"><h3>分析任务进展</h3><span>共 ' + count(block.total) + ' 个</span></div>' + meta + (tasks.length ? '<ul class="reply-task-list">' + tasks.slice(0, 3).map(row).join('') + '</ul>' + (tasks.length > 3 ? '<details class="reply-more"><summary>展开其余 ' + (tasks.length - 3) + ' 个任务</summary><ul class="reply-task-list">' + tasks.slice(3).map(row).join('') + '</ul></details>' : '') : '<p>当前范围没有分析任务。</p>') + (block.total > tasks.length ? '<p class="reply-card-meta">仅展示最近 ' + tasks.length + ' 个任务，可前往「分析任务」查看全部。</p>' : '') + '</section>';
    }
    if (block.type === 'evidence' && block.id) {
      const excerpts = Array.isArray(block.excerpts) ? block.excerpts : [];
      return '<section class="reply-card reply-evidence" aria-label="记录依据"><div class="reply-card-heading"><h3>' + escape(block.name || '记录依据') + '</h3>' + action({type:'record', id:block.id, label:'查看完整依据'}) + '</div>' + meta + '<details class="reply-more"><summary>展开已读取的原文片段</summary>' + (excerpts.length ? excerpts.map(part => '<div class="reply-excerpt"><h4>' + escape(part.label) + '</h4><blockquote>' + escape(part.text) + '</blockquote>' + (part.truncated ? '<p class="reply-card-meta">片段已截取，完整内容请查看原文。</p>' : '') + '</div>').join('') : '<p>请打开完整依据查看原文。</p>') + '<p class="reply-card-meta">原文片段用于核对；完整原文及评级报告以记录详情为准。</p></details></section>';
    }
    return '';
  }
  function presentation(value, helpers) {
    if (value?.version !== 1 || !Array.isArray(value.blocks)) return {html:'', covered:new Set()};
    const covered = new Set(), rendered = [];
    for (const block of value.blocks) {
      if (!block || typeof block !== 'object') continue;
      const html = blockHtml(block, helpers); if (!html) continue;
      rendered.push(html);
      if (block.type === 'metrics') covered.add('analytics:');
      if (block.type === 'analysis_tasks') for (const task of block.tasks) covered.add('batch:' + task.id);
      if (block.type === 'evidence') covered.add('record:' + block.id);
    }
    return {html: rendered.length ? '<div class="reply-business-blocks">' + rendered.join('') + '</div>' : '', covered};
  }
  const api = {markdown, body, presentation};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WorkspaceReply = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
