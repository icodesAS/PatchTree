import { useState } from 'react';
import { Copy, Check, Download, FileText } from 'lucide-react';

interface Props {
  diff: string;
  nodeId?: string;
}

export default function DiffViewer({ diff, nodeId }: Props) {
  const [copiedDiff, setCopiedDiff] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const patchFilename = `patch-${nodeId ? nodeId.slice(0, 8) : 'fix'}.patch`;
  const applyCmd = `git apply ${patchFilename}`;

  const handleCopyDiff = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopiedDiff(true);
      setTimeout(() => setCopiedDiff(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const handleCopyCmd = async () => {
    try {
      await navigator.clipboard.writeText(applyCmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const handleDownload = () => {
    const blob = new Blob([diff], { type: 'text/x-diff;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = patchFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const lines = diff.split('\n');

  const modifiedFiles = Array.from(
    new Set(
      lines
        .filter((l) => l.startsWith('+++ b/') || l.startsWith('+++ '))
        .map((l) => l.replace(/^\+\+\+\s+(b\/)?/, '').trim())
        .filter((f) => f && f !== '/dev/null'),
    ),
  );

  const primaryFile = modifiedFiles[0] || 'patch.diff';

  let addedCount = 0;
  let removedCount = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) addedCount++;
    else if (line.startsWith('-') && !line.startsWith('---')) removedCount++;
  }

  return (
    <div className="diff-block">
      <div className="diff-toolbar">
        <div className="diff-toolbar__left">
          <span className="diff-file-chip mono" title={modifiedFiles.join(', ')}>
            <FileText size={13} strokeWidth={1.5} />
            <span>{primaryFile}</span>
          </span>
          <span className="diff-counts mono num">
            <span className="diff-counts__add">+{addedCount}</span>
            <span className="diff-counts__del">−{removedCount}</span>
          </span>
        </div>

        <div className="diff-toolbar__right">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={handleCopyDiff}
          >
            {copiedDiff ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.5} />}
            <span>{copiedDiff ? 'Copied' : 'Copy diff'}</span>
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={handleDownload}
          >
            <Download size={13} strokeWidth={1.5} />
            <span>Download .patch</span>
          </button>
        </div>
      </div>

      <div className="diff-code-area mono">
        <table className="diff-table" role="presentation">
          <tbody>
            {lines.map((rawLine, idx) => {
              const isFileHeader = rawLine.startsWith('---') || rawLine.startsWith('+++');
              const isHunk = rawLine.startsWith('@@');
              const isAdd = !isFileHeader && rawLine.startsWith('+');
              const isDel = !isFileHeader && rawLine.startsWith('-');

              const rowType = isHunk
                ? 'hunk'
                : isFileHeader
                ? 'header'
                : isAdd
                ? 'add'
                : isDel
                ? 'del'
                : 'ctx';

              const sign = isAdd ? '+' : isDel ? '-' : ' ';
              const content =
                isAdd || isDel
                  ? rawLine.slice(1)
                  : rawLine;

              return (
                <tr key={idx} className={`diff-row diff-row--${rowType}`}>
                  <td className="diff-gutter num">{idx + 1}</td>
                  <td className="diff-sign">{isHunk || isFileHeader ? '' : sign}</td>
                  <td className="diff-code">{content || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="diff-apply">
        <span className="diff-apply__label">Apply locally</span>
        <div className="diff-apply__box">
          <code className="diff-apply__cmd mono">{applyCmd}</code>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={handleCopyCmd}
            aria-label="Copy git apply command"
            title={copiedCmd ? 'Copied' : 'Copy command'}
          >
            {copiedCmd ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}
