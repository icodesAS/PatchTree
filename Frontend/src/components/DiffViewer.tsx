import { useState } from 'react';
import { Copy, Check, Download } from 'lucide-react';

interface Props {
  diff: string;
  nodeId?: string;
}

export default function DiffViewer({ diff, nodeId }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(diff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([diff], { type: 'text/x-diff;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `patch-${nodeId ? nodeId.slice(0, 8) : 'fix'}.patch`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const lines = diff.split('\n');

  return (
    <div className="diff-card">
      <div className="diff-card__header">
        <span className="diff-card__title">Unified Diff ({lines.length} lines)</span>
        <div className="diff-card__actions">
          <button className="btn-copy" onClick={handleCopy} title="Copy patch to clipboard">
            {copied ? <Check size={12} className="text-pass" /> : <Copy size={12} />}
            <span>{copied ? 'Copied!' : 'Copy Diff'}</span>
          </button>
          <button className="btn-copy" onClick={handleDownload} title="Download .patch file for git apply">
            <Download size={12} />
            <span>Download .patch</span>
          </button>
        </div>
      </div>
      <pre className="diff-viewer">
        {lines.map((line, i) => {
          const cls = line.startsWith('+') && !line.startsWith('+++')
            ? 'diff-add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'diff-del'
              : line.startsWith('@@')
                ? 'diff-hunk'
                : 'diff-ctx';
          return (
            <div key={i} className={`diff-line diff-line--${cls}`}>
              <span className="diff-line__num">{i + 1}</span>
              <span className="diff-line__text">{line}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
