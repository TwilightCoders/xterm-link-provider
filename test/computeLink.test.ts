import * as assert from 'assert';
import { computeLink } from '../src/index';
import type { Terminal } from '@xterm/xterm';

/**
 * Minimal Terminal mock for computeLink tests.
 * Simulates a terminal buffer with a single non-wrapped line.
 */
function mockTerminal(lines: string[], cols = 200): Terminal {
  return {
    cols,
    buffer: {
      active: {
        getLine(index: number) {
          if (index < 0 || index >= lines.length) return undefined;
          const text = lines[index];
          return {
            isWrapped: false,
            length: text.length,
            translateToString(_trim?: boolean) { return text; },
            getCell(i: number, cell: any) {
              const ch = i < text.length ? text[i] : '';
              cell._char = ch;
              cell._width = ch ? 1 : 0;
              return cell;
            },
          };
        },
        getNullCell() {
          return {
            _char: '',
            _width: 0,
            getChars() { return this._char; },
            getWidth() { return this._width; },
          };
        },
      },
    },
  } as unknown as Terminal;
}

/**
 * Advanced Terminal mock with explicit cell definitions.
 * Simulates wide characters, empty cells (from cursor moves), etc.
 */
interface MockCell {
  chars: string;
  width: number;
}

function mockTerminalWithCells(linesCells: MockCell[][], cols = 200): Terminal {
  return {
    cols,
    buffer: {
      active: {
        getLine(index: number) {
          if (index < 0 || index >= linesCells.length) return undefined;
          const cells = linesCells[index];
          // translateToString: produce string as xterm.js would —
          // each cell with width > 0 contributes chars or a space if empty
          let str = '';
          for (const c of cells) {
            if (c.width === 0) continue; // skip wide char continuations
            str += c.chars.length > 0 ? c.chars : ' ';
          }
          return {
            isWrapped: false,
            length: cells.length,
            translateToString(_trim?: boolean) { return _trim ? str.trimEnd() : str; },
            getCell(i: number, cell: any) {
              if (i < cells.length) {
                cell._char = cells[i].chars;
                cell._width = cells[i].width;
              } else {
                cell._char = '';
                cell._width = 0;
              }
              return cell;
            },
          };
        },
        getNullCell() {
          return {
            _char: '',
            _width: 0,
            getChars() { return this._char; },
            getWidth() { return this._width; },
          };
        },
      },
    },
  } as unknown as Terminal;
}

/** Helper: create a normal single-width cell */
function ch(c: string): MockCell { return { chars: c, width: 1 }; }
/** Helper: create a wide character (2 cells) */
function wide(c: string): MockCell[] { return [{ chars: c, width: 2 }, { chars: '', width: 0 }]; }
/** Helper: create an empty cell (from cursor movement like \e[1C]) */
function empty(): MockCell { return { chars: '', width: 1 }; }
/** Helper: convert a plain string to cells */
function strCells(s: string): MockCell[] { return s.split('').map(ch); }

suite('computeLink', () => {
  // Regex with a capture group (matchIndex=1), as typically used
  const LINK_REGEX = /(https?:\/\/[^\s"'`()\[\]{}]+|(?:~|\.\.?)?\/[^\s"'`()\[\]{}]*[^\s"'`()\[\]{}\/]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.])/;

  test('should find a simple relative path', () => {
    const term = mockTerminal(['Look at src/webview/tabManager.ts for details']);
    const links = computeLink(1, LINK_REGEX, term);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/webview/tabManager.ts');
    // Should start at the correct column (1-based)
    assert.strictEqual(links[0].range.start.x, 9); // "Look at " = 8 chars, path starts at col 9
  });

  test('should find correct position when substring appears earlier in line', () => {
    // "tabManager.ts" appears as a bare word before the full path.
    // The bare word does NOT match the regex (no slash), but indexOf
    // would find it first if searching the whole line.
    const line = 'See tabManager.ts docs in src/webview/tabManager.ts for details';
    const term = mockTerminal([line]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/webview/tabManager.ts');

    // The link should point to "src/webview/tabManager.ts" at index 26
    const expectedStart = line.indexOf('src/webview/tabManager.ts') + 1; // 1-based
    assert.strictEqual(links[0].range.start.x, expectedStart);
  });

  test('should find correct positions for two paths where second contains first', () => {
    const line = 'Compare utils/helper.ts with src/utils/helper.ts';
    const term = mockTerminal([line]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 2);
    assert.strictEqual(links[0].text, 'utils/helper.ts');
    assert.strictEqual(links[1].text, 'src/utils/helper.ts');

    // First path starts at "Compare " (8 chars) -> col 9
    assert.strictEqual(links[0].range.start.x, 9);
    // Second path starts at "Compare utils/helper.ts with " (29 chars) -> col 30
    assert.strictEqual(links[1].range.start.x, 30);
  });

  test('should find multiple paths with shared substrings', () => {
    const line = 'Modified src/utils/log.ts and src/utils/log.test.ts';
    const term = mockTerminal([line]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 2);
    assert.strictEqual(links[0].text, 'src/utils/log.ts');
    assert.strictEqual(links[1].text, 'src/utils/log.test.ts');

    assert.strictEqual(links[0].range.start.x, 10);
    assert.strictEqual(links[1].range.start.x, 31);
  });

  test('should handle path preceded by non-matching text with same basename', () => {
    // Regex with lookbehind-style prefix that creates match[0] != match[1]
    // Using a regex where the capture group is a subset of the full match
    const prefixRegex = /(?:in |at )([a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.])/;
    const line = 'error in src/utils/helper.ts at line 42';
    const term = mockTerminal([line]);
    const links = computeLink(1, prefixRegex, term);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/utils/helper.ts');
    // "error in " = 9 chars, path starts at col 10
    assert.strictEqual(links[0].range.start.x, 10);
  });

  test('should not misalign when capture group text appears before regex match', () => {
    // This is the core indexOf bug: when match[0] != match[1] (capture group)
    // and match[1] text appears earlier in the line, indexOf finds the wrong position.
    //
    // Example: regex /(?:in )([a-z\/\.]+)/ matches "in src/a.ts" at index 21,
    // capture group is "src/a.ts". But indexOf("src/a.ts", 0) finds it at index 6
    // (the bare occurrence), not at index 24 (inside the regex match).
    const prefixRegex = /(?:in |at )([a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.])/;
    const line = 'Found src/a.ts error in src/a.ts';
    const term = mockTerminal([line]);
    const links = computeLink(1, prefixRegex, term);

    // The regex should only match "in src/a.ts" (one match), with
    // capture group "src/a.ts" at column 25.
    // BUG: indexOf finds "src/a.ts" at position 6 (the bare occurrence),
    // causing rex.lastIndex to advance to 14, which then re-matches
    // "in src/a.ts" at position 21 — producing a DUPLICATE link.
    // With the fix, there should be exactly 1 link at the correct position.
    assert.strictEqual(links.length, 1, `Expected 1 link but found ${links.length}: ${JSON.stringify(links.map(l => ({ text: l.text, x: l.range.start.x })))}`);
    assert.strictEqual(links[0].text, 'src/a.ts');
    assert.strictEqual(links[0].range.start.x, 25);
  });

  test('should handle wide characters before a path', () => {
    // Simulates: ⏺ Update(src/terminal/ptyManager.ts)
    // ⏺ is a wide char (2 cells), followed by an empty cell from \e[1C
    // This is exactly what Claude Code outputs for file edits.
    const cells: MockCell[] = [
      ...wide('⏺'),           // cells 0-1: wide char
      empty(),                 // cell 2: empty from cursor move
      ...strCells('Update(src/terminal/ptyManager.ts)'),
    ];
    const term = mockTerminalWithCells([cells]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/terminal/ptyManager.ts');
    // ⏺ takes 2 cells, empty takes 1, "Update(" is 7 chars at cells 3-9
    // "src" starts at cell 10 → x=11 (1-based)
    assert.strictEqual(links[0].range.start.x, 11);
  });

  test('should handle multiple wide characters and empty cells', () => {
    // Two wide chars with empty cells: ⏺ ⎿ src/file.ts
    const cells: MockCell[] = [
      ...wide('⏺'),           // cells 0-1
      empty(),                 // cell 2
      ...wide('⎿'),           // cells 3-4
      empty(),                 // cell 5
      ...strCells('src/file.ts'),
    ];
    const term = mockTerminalWithCells([cells]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/file.ts');
    // cells 0-1: ⏺, cell 2: empty, cells 3-4: ⎿, cell 5: empty
    // "src" starts at cell 6 → x=7
    assert.strictEqual(links[0].range.start.x, 7);
  });

  test('should correctly position link end with wide chars before it', () => {
    // ⏺ src/a.ts
    const cells: MockCell[] = [
      ...wide('⏺'),
      empty(),
      ...strCells('src/a.ts'),
    ];
    const term = mockTerminalWithCells([cells]);
    const links = computeLink(1, LINK_REGEX, term);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'src/a.ts');
    // "src/a.ts" is 8 chars, starts at cell 3 → x=4 start
    // last char 's' at cell 10 → x = 10 + width(1) = 11
    assert.strictEqual(links[0].range.start.x, 4);
    assert.strictEqual(links[0].range.end.x, 11);
  });

  test('should verify link text matches line content at reported position', () => {
    // Invariant: for every link, the text at the reported position
    // must equal the link text. This catches indexOf misalignment.
    const lines = [
      'See tabManager.ts docs in src/webview/tabManager.ts for details',
      'Compare utils/helper.ts with src/utils/helper.ts',
      'error at src/a.ts and src/b.ts and src/a.ts again',
    ];

    for (const line of lines) {
      const term = mockTerminal([line]);
      const links = computeLink(1, LINK_REGEX, term);

      for (const link of links) {
        const startIdx = link.range.start.x - 1; // convert to 0-based
        const extracted = line.substring(startIdx, startIdx + link.text.length);
        assert.strictEqual(
          extracted,
          link.text,
          `Link "${link.text}" at col ${link.range.start.x} should match ` +
          `"${extracted}" in line "${line}"`,
        );
      }
    }
  });
});
