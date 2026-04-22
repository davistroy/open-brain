/**
 * Client-side export helpers for brief content.
 * Both functions are browser-only — call only from 'use client' components.
 */

/**
 * Convert an HTML string to clean Markdown-flavoured plain text.
 * Handles the common tags produced by the brief body_html renderer:
 * h1-h6, p, ul/ol/li, blockquote, code, pre, a, br, strong/em.
 * Falls back to raw text content for unrecognised tags.
 */
function htmlToMarkdown(html: string): string {
  // Use a DOMParser for robust HTML → DOM conversion (browser only)
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  function nodeToMd(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const childMd = () => Array.from(el.childNodes).map(nodeToMd).join('');

    switch (tag) {
      case 'h1': return `\n# ${childMd()}\n\n`;
      case 'h2': return `\n## ${childMd()}\n\n`;
      case 'h3': return `\n### ${childMd()}\n\n`;
      case 'h4': return `\n#### ${childMd()}\n\n`;
      case 'h5': return `\n##### ${childMd()}\n\n`;
      case 'h6': return `\n###### ${childMd()}\n\n`;
      case 'p':  return `${childMd()}\n\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n\n';
      case 'strong':
      case 'b':  return `**${childMd()}**`;
      case 'em':
      case 'i':  return `_${childMd()}_`;
      case 'code': return `\`${childMd()}\``;
      case 'pre': {
        const codeEl = el.querySelector('code');
        const lang = codeEl?.className?.replace(/language-/, '') ?? '';
        const content = codeEl ? (codeEl.textContent ?? '') : (el.textContent ?? '');
        return `\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
      }
      case 'blockquote': return `\n> ${childMd().trim().replace(/\n/g, '\n> ')}\n\n`;
      case 'ul': {
        const items = Array.from(el.querySelectorAll(':scope > li'));
        return '\n' + items.map(li => `- ${li.textContent?.trim() ?? ''}`).join('\n') + '\n\n';
      }
      case 'ol': {
        const items = Array.from(el.querySelectorAll(':scope > li'));
        return '\n' + items.map((li, i) => `${i + 1}. ${li.textContent?.trim() ?? ''}`).join('\n') + '\n\n';
      }
      case 'li': return ''; // handled by ul/ol
      case 'a': {
        const href = el.getAttribute('href') ?? '';
        const text = childMd();
        return href ? `[${text}](${href})` : text;
      }
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'span':
        return childMd();
      // Skip structural / presentation tags that produce no text
      case 'script':
      case 'style':
      case 'nav':
      case 'header':
      case 'footer':
        return '';
      default:
        return childMd();
    }
  }

  const raw = Array.from(doc.body.childNodes).map(nodeToMd).join('');
  // Collapse 3+ consecutive newlines → 2 (paragraph gap)
  return raw.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Slugify a title for use in a filename.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims edges.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Trigger a `.md` file download from the given HTML string.
 *
 * @param html  Brief body_html (pre-rendered HTML). Falls back to empty string.
 * @param title Brief title — used to construct the filename slug.
 */
export function downloadMarkdown(html: string, title: string): void {
  const markdown = html ? htmlToMarkdown(html) : '(No content)\n';
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `${slugify(title) || 'brief'}-${date}.md`;

  const blob = new Blob([markdown], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  // Cleanup after the browser has had a tick to initiate the download
  requestAnimationFrame(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

/**
 * Open the browser print dialog.
 * Relies on `@media print` CSS to hide shell chrome.
 */
export function triggerPrint(): void {
  window.print();
}
