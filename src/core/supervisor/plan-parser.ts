/**
 * Plan parser — extracts work packages from a markdown plan file.
 *
 * Supports two plan formats:
 * 1. Numbered tasks with ### headers:  "### Task 1: Title"
 * 2. Simple numbered list:             "1. Title"
 *
 * Each WP gets the title and everything until the next WP as description.
 */

export interface ParsedWP {
  seq: number;
  title: string;
  description: string;
}

export interface ParsedPlan {
  title: string;
  description: string;
  workPackages: ParsedWP[];
}

/**
 * Parse a plan markdown file into structured work packages.
 */
export function parsePlan(content: string): ParsedPlan {
  const lines = content.split('\n');

  // Extract plan title from first # heading
  let title = 'Untitled Plan';
  let descriptionLines: string[] = [];
  let headerEndIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const h1 = /^#\s+(.+)/.exec(lines[i]);
    if (h1 && i === findFirstHeading(lines)) {
      title = h1[1].trim();
      headerEndIndex = i + 1;
      break;
    }
  }

  // Collect description (text between title and first task)
  const firstWPIndex = findFirstWPLine(lines, headerEndIndex);
  if (firstWPIndex > headerEndIndex) {
    descriptionLines = lines.slice(headerEndIndex, firstWPIndex);
  }
  const description = descriptionLines.join('\n').trim();

  // Parse work packages
  const workPackages = extractWorkPackages(lines, headerEndIndex);

  return { title, description, workPackages };
}

/**
 * Create a single-WP plan from a task description.
 */
export function createSingleWPPlan(taskDescription: string): ParsedPlan {
  return {
    title: taskDescription.slice(0, 80),
    description: taskDescription,
    workPackages: [{
      seq: 1,
      title: taskDescription.slice(0, 80),
      description: taskDescription,
    }],
  };
}

// ---- Internal ----

function findFirstHeading(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) return i;
  }
  return 0;
}

function findFirstWPLine(lines: string[], startFrom: number): number {
  for (let i = startFrom; i < lines.length; i++) {
    if (isWPHeader(lines[i])) return i;
  }
  return lines.length;
}

function isWPHeader(line: string): boolean {
  // ### Task N: Title
  if (/^###\s+Task\s+\d+/i.test(line)) return true;
  // ### N. Title
  if (/^###\s+\d+\.\s+/.test(line)) return true;
  // ## Task N: Title (h2 variant)
  if (/^##\s+Task\s+\d+/i.test(line)) return true;
  return false;
}

function extractWPTitle(line: string): string {
  // ### Task N: Title → Title
  let m = /^#{2,3}\s+Task\s+\d+[:.]\s*(.+)/i.exec(line);
  if (m) return m[1].trim();
  // ### N. Title → Title
  m = /^#{2,3}\s+\d+\.\s*(.+)/.exec(line);
  if (m) return m[1].trim();
  // Fallback: strip markdown headers
  return line.replace(/^#+\s*/, '').trim();
}

function extractWorkPackages(lines: string[], startFrom: number): ParsedWP[] {
  const wps: ParsedWP[] = [];
  let currentWP: { title: string; descLines: string[] } | null = null;
  let seq = 0;

  for (let i = startFrom; i < lines.length; i++) {
    if (isWPHeader(lines[i])) {
      // Save previous WP
      if (currentWP) {
        wps.push({
          seq,
          title: currentWP.title,
          description: currentWP.descLines.join('\n').trim(),
        });
      }
      seq++;
      currentWP = {
        title: extractWPTitle(lines[i]),
        descLines: [],
      };
    } else if (currentWP) {
      currentWP.descLines.push(lines[i]);
    }
  }

  // Save last WP
  if (currentWP) {
    wps.push({
      seq,
      title: currentWP.title,
      description: currentWP.descLines.join('\n').trim(),
    });
  }

  // If no structured WPs found, try simple numbered list
  if (wps.length === 0) {
    return extractSimpleNumberedList(lines, startFrom);
  }

  return wps;
}

function extractSimpleNumberedList(lines: string[], startFrom: number): ParsedWP[] {
  const wps: ParsedWP[] = [];
  let seq = 0;

  for (let i = startFrom; i < lines.length; i++) {
    const m = /^\d+\.\s+(.+)/.exec(lines[i]);
    if (m) {
      seq++;
      wps.push({ seq, title: m[1].trim(), description: '' });
    }
  }

  return wps;
}
