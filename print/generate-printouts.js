// generate-printouts.js — builds the paper fallback pack from the SAME
// content JSON the live app uses, so printouts never drift from what's
// actually configured. Regenerate any time you edit the questions:
//
//   node print/generate-printouts.js content/session.json print/output
//
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, AlignmentType, PageBreak, VerticalAlign
} = require('docx');

const contentPath = process.argv[2] || path.join(__dirname, '..', 'content', 'session.example.json');
const outDir = process.argv[3] || path.join(__dirname, 'output');
fs.mkdirSync(outDir, { recursive: true });
const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

// US Letter in DXA (docx skill gotcha: default is A4)
const PAGE = { width: 12240, height: 15840 };
const MARGIN = { top: 900, bottom: 900, left: 900, right: 900 };

const CELL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
  bottom: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
  left: { style: BorderStyle.SINGLE, size: 2, color: '999999' },
  right: { style: BorderStyle.SINGLE, size: 2, color: '999999' }
};

function cell(text, { width, bold = false, shade = null, align = AlignmentType.LEFT, size = 20 } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: CELL_BORDER,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({ alignment: align, children: [new TextRun({ text: String(text), bold, size })] })]
  });
}

function blankLine(widthChars = 40) {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '333333' } },
    spacing: { before: 100, after: 200 },
    children: [new TextRun({ text: ' '.repeat(widthChars) })]
  });
}

function h(text, level = HeadingLevel.HEADING_2) {
  return new Paragraph({ heading: level, spacing: { before: 300, after: 120 }, children: [new TextRun(text)] });
}

function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text, ...opts })] });
}

// Flatten rounds->questions with round title attached, and a running number.
function flatten() {
  const out = [];
  let n = 0;
  content.rounds.forEach((round, ri) => {
    round.questions.forEach((q) => {
      n += 1;
      out.push({ n, roundTitle: round.title, roundIndex: ri, ...q });
    });
  });
  return out;
}
const flat = flatten();

// ---------------------------------------------------------------------
// DOC 1 — HOST MASTER PACK: answer keys, scoring reference, hint script,
// manual scoring tally grid. This is the single sheet the host runs the
// whole quiz from if the app dies.
// ---------------------------------------------------------------------
function buildHostPack() {
  const children = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Jasper's 40th — Host Master Pack (Paper Fallback)")] }));
  children.push(p('If the app fails, run the whole quiz from this pack. Read the public wording aloud, use team/Jasper wording only when addressing that group directly, and score by hand on the tally grid at the end.', { italics: true, size: 20 }));
  children.push(blankLine(0));

  flat.forEach((q) => {
    if (q.n > 1 && content.rounds[q.roundIndex] && flat[flat.indexOf(q) - 1]?.roundIndex !== q.roundIndex) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    children.push(h(`${q.roundTitle}`, HeadingLevel.HEADING_1));
    children.push(h(`Q${q.n}. ${q.public_display.title || ''}`));
    children.push(p(`Read aloud: ${q.public_display.body}`, { bold: true }));

    children.push(p(`Team wording: ${q.team_view.body}`));
    if (q.team_view.options && q.team_view.options.length) {
      children.push(p(`Team options: ${q.team_view.options.join(' / ')}`));
    }
    children.push(p(`Jasper wording: ${q.jasper_view.body}`));
    if (q.jasper_view.options && q.jasper_view.options.length) {
      children.push(p(`Jasper options: ${q.jasper_view.options.join(' / ')}`));
    } else {
      children.push(p('Jasper options: none — free answer only.'));
    }

    const hints = q.team_view.hints || [];
    children.push(p(`Hint 1 (release only if stuck): ${hints[0] || '—'}`));
    children.push(p(`Hint 2 (release only if still stuck): ${hints[1] || '—'}`));

    const ansKey = q.answer_key.value !== undefined ? q.answer_key.value : JSON.stringify(q.answer_key.parts || q.answer_key);
    children.push(p(`ANSWER: ${ansKey}`, { bold: true, color: '1a6b1a' }));
    if (q.accepted_answers && q.accepted_answers.length) {
      children.push(p(`Also accept: ${q.accepted_answers.join(', ')}`));
    }
    if (q.reveal_content && q.reveal_content.note) {
      children.push(p(`Reveal line: ${q.reveal_content.note}`, { italics: true }));
    }

    const s = q.scoring;
    const stageVals = s.hint_stage_values || [3, 2, 1];
    let scoringLine = `Scoring — Team: ${stageVals[0]} unaided / ${stageVals[1]} after Hint 1 / ${stageVals[2]} after Hint 2.`;
    scoringLine += `  Jasper: ${s.jasper_correct_no_loss ? 'correct = no loss' : `correct = +${s.jasper_correct_points ?? Math.abs(s.jasper_base)}`}, incorrect = ${s.jasper_base} (max loss ${s.max_loss ?? 'none'}).`;
    if (s.per_part_value) scoringLine += ` Per-part value: ${s.per_part_value} each.`;
    children.push(p(scoringLine, { size: 19 }));
    children.push(blankLine(0));
  });

  // ---- Manual scoring tally grid ----
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(h('Manual Scoring Tally Grid', HeadingLevel.HEADING_1));
  children.push(p('Write team names in the blank rows. Enter points per question as you mark them (remember: value depends on hint stage used — see pack above). Jasper penalties are negative numbers. Total each row at the end.', { italics: true, size: 20 }));

  const nQ = flat.length;
  const nameColWidth = 2600;
  const qColWidth = Math.floor((10440 - nameColWidth - 1200) / nQ); // remaining width split across question columns
  const totalColWidth = 1200;

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell('Team / Jasper', { width: nameColWidth, bold: true, shade: 'DDDDDD' }),
      ...flat.map(q => cell(`Q${q.n}`, { width: qColWidth, bold: true, shade: 'DDDDDD', align: AlignmentType.CENTER })),
      cell('Total', { width: totalColWidth, bold: true, shade: 'DDDDDD', align: AlignmentType.CENTER })
    ]
  });

  const blankRows = [];
  const rowCount = 3; // 3 teams; Jasper row appended separately
  for (let i = 0; i < rowCount; i++) {
    blankRows.push(new TableRow({
      children: [
        cell('', { width: nameColWidth }),
        ...flat.map(q => cell('', { width: qColWidth, align: AlignmentType.CENTER })),
        cell('', { width: totalColWidth, align: AlignmentType.CENTER })
      ]
    }));
  }
  const jasperRow = new TableRow({
    children: [
      cell('JASPER', { width: nameColWidth, bold: true, shade: 'FBE4E1' }),
      ...flat.map(q => cell('', { width: qColWidth, align: AlignmentType.CENTER, shade: 'FBE4E1' })),
      cell('', { width: totalColWidth, align: AlignmentType.CENTER, shade: 'FBE4E1' })
    ]
  });

  children.push(new Table({
    width: { size: 10440, type: WidthType.DXA },
    columnWidths: [nameColWidth, ...flat.map(() => qColWidth), totalColWidth],
    rows: [headerRow, ...blankRows, jasperRow]
  }));

  children.push(blankLine(0));
  children.push(p('Question point-value quick reference (unaided / after Hint 1 / after Hint 2):', { bold: true }));
  flat.forEach(q => {
    const sv = q.scoring.hint_stage_values || [3, 2, 1];
    children.push(p(`Q${q.n}: ${sv.join(' / ')} — Jasper incorrect: ${q.scoring.jasper_base}`, { size: 19 }));
  });

  return new Document({
    sections: [{ properties: { page: { size: PAGE, margin: MARGIN } }, children }]
  });
}

// ---------------------------------------------------------------------
// DOC 2 — TEAM ANSWER SHEET (generic template, photocopy one per team)
// ---------------------------------------------------------------------
function buildTeamSheet() {
  const children = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Jasper's 40th — Team Answer Sheet")] }));
  children.push(p('Team name:'));
  children.push(blankLine(50));

  flat.forEach((q) => {
    children.push(h(`Q${q.n}. ${q.team_view.body}`, HeadingLevel.HEADING_2));
    if (q.team_view.options && q.team_view.options.length) {
      children.push(p(`Options: ${q.team_view.options.join('   /   ')}`));
      children.push(p('Circle your answer above, or write it below:'));
    }
    children.push(p('Answer:'));
    children.push(blankLine(50));
  });

  return new Document({ sections: [{ properties: { page: { size: PAGE, margin: MARGIN } }, children }] });
}

// ---------------------------------------------------------------------
// DOC 3 — JASPER ANSWER SHEET
// ---------------------------------------------------------------------
function buildJasperSheet() {
  const children = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Jasper's 40th — Jasper's Answer Sheet")] }));
  children.push(p('No help. No options (mostly). Good luck.', { italics: true }));
  children.push(blankLine(0));

  flat.forEach((q) => {
    children.push(h(`Q${q.n}. ${q.jasper_view.body}`, HeadingLevel.HEADING_2));
    if (q.jasper_view.options && q.jasper_view.options.length) {
      children.push(p(`Options: ${q.jasper_view.options.join('   /   ')}`));
    }
    children.push(p('Answer:'));
    children.push(blankLine(50));
  });

  return new Document({ sections: [{ properties: { page: { size: PAGE, margin: MARGIN } }, children }] });
}

async function main() {
  const hostDoc = buildHostPack();
  const teamDoc = buildTeamSheet();
  const jasperDoc = buildJasperSheet();

  await Packer.toBuffer(hostDoc).then(buf => fs.writeFileSync(path.join(outDir, 'Host_Master_Pack.docx'), buf));
  await Packer.toBuffer(teamDoc).then(buf => fs.writeFileSync(path.join(outDir, 'Team_Answer_Sheet.docx'), buf));
  await Packer.toBuffer(jasperDoc).then(buf => fs.writeFileSync(path.join(outDir, 'Jasper_Answer_Sheet.docx'), buf));

  console.log('Written to', outDir);
  console.log('- Host_Master_Pack.docx');
  console.log('- Team_Answer_Sheet.docx (photocopy one per team)');
  console.log('- Jasper_Answer_Sheet.docx');
}

main();
