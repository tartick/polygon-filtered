import { newestFirst } from './store.mjs';

const stripIllegal = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');

const esc = s => stripIllegal(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const cdata = s => `<![CDATA[${stripIllegal(s).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

export const escHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function itemXml(item, showReason) {
  const description = showReason && item.reason ? `[Filtered: ${escHtml(String(item.reason).slice(0, 200))}] ${item.description}` : item.description;
  const parts = [
    `<title>${cdata(item.title)}</title>`,
    `<link>${esc(item.link)}</link>`,
    `<guid isPermaLink="${item.guid === item.link}">${esc(item.guid)}</guid>`,
  ];
  if (item.creator) parts.push(`<dc:creator>${cdata(item.creator)}</dc:creator>`);
  if (item.pubDate) parts.push(`<pubDate>${esc(item.pubDate)}</pubDate>`);
  for (const c of item.categories ?? []) parts.push(`<category>${cdata(c)}</category>`);
  if (item.enclosure?.url) {
    parts.push(`<enclosure url="${esc(item.enclosure.url)}" length="${esc(item.enclosure.length || '0')}" type="${esc(item.enclosure.type)}"/>`);
  }
  parts.push(`<description>${cdata(description)}</description>`);
  if (item.contentEncoded) parts.push(`<content:encoded>${cdata(item.contentEncoded)}</content:encoded>`);
  return `    <item>\n      ${parts.join('\n      ')}\n    </item>`;
}

export function buildFeed(items, { title, description, selfUrl, limit = 50, showReason = false, now = new Date() }) {
  const selected = [...items].sort(newestFirst).slice(0, limit);
  const newest = selected.map(i => Date.parse(i.pubDate)).find(t => !Number.isNaN(t));
  const lastBuild = (newest === undefined ? now : new Date(newest)).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(title)}</title>
    <link>https://www.polygon.com</link>
    <description>${esc(description)}</description>
    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
    <language>en-US</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${selected.map(i => itemXml(i, showReason)).join('\n')}
  </channel>
</rss>
`;
}
