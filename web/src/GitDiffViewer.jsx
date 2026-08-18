import React, { useState, useEffect } from 'react';

// Git状态标签
function StatusBadge({ status }) {
  const labels = {
    modified: { text: '修改', color: '#f2c14e' },
    added: { text: '新增', color: '#0f8a5f' },
    deleted: { text: '删除', color: '#d93a3a' },
    untracked: { text: '未跟踪', color: '#67707f' },
  };
  const { text, color } = labels[status] || labels.modified;
  return (
    <span className="git-status-badge" style={{ backgroundColor: color }}>
      {text}
    </span>
  );
}

// 简单的diff行渲染
function DiffLine({ line }) {
  let className = 'diff-line';
  if (line.startsWith('+')) className += ' diff-add';
  else if (line.startsWith('-')) className += ' diff-remove';
  else if (line.startsWith('@@')) className += ' diff-hunk';

  return <div className={className}>{line}</div>;
}

// Diff查看器组件
function DiffView({ filePath, diff, onClose }) {
  const lines = diff.split('\n');

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <span className="diff-viewer-path">{filePath}</span>
        <button className="diff-viewer-close" onClick={onClose}>×</button>
      </div>
      <div className="diff-viewer-content">
        {lines.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </div>
    </div>
  );
}

export default function GitDiffViewer({ cwd }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [diff, setDiff] = useState(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (!cwd) return;

    setLoading(true);
    setError(null);

    fetch('/api/git/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.error && data.error !== 'Not a git repository') {
          throw new Error(data.error);
        }
        setFiles(data.files || []);
        if (data.error === 'Not a git repository') {
          setError('当前目录不是Git仓库');
        }
        setLoading(false);
      })
      .catch(err => {
        setError(String(err.message || err));
        setLoading(false);
      });
  }, [cwd]);

  const handleFileClick = async (filePath) => {
    setSelectedFile(filePath);
    setLoadingDiff(true);
    setDiff(null);

    try {
      const res = await fetch('/api/git/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath, cwd }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDiff(data.diff || '无差异');
    } catch (err) {
      setDiff(`错误：${err.message || err}`);
    } finally {
      setLoadingDiff(false);
    }
  };

  const closeDiffViewer = () => {
    setSelectedFile(null);
    setDiff(null);
  };

  if (loading) {
    return (
      <div className="git-diff-viewer">
        <div className="git-loading">
          <div className="spinner" />
          <p>检查Git状态...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-diff-viewer">
        <div className="git-error">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="git-diff-viewer">
        <div className="git-empty">
          <p className="muted">工作目录是干净的</p>
          <p className="muted small">没有未提交的更改</p>
        </div>
      </div>
    );
  }

  return (
    <div className="git-diff-viewer">
      <div className="git-header">
        <span className="git-count">{files.length} 个文件有更改</span>
      </div>
      <div className="git-file-list">
        {files.map((file, i) => (
          <div
            key={i}
            className="git-file-item"
            onClick={() => handleFileClick(file.path)}
          >
            <StatusBadge status={file.status} />
            <span className="git-file-path">{file.path}</span>
            <span className="git-file-arrow">›</span>
          </div>
        ))}
      </div>
      {selectedFile && (
        <div className="diff-viewer-overlay" onClick={closeDiffViewer}>
          <div className="diff-viewer-modal" onClick={(e) => e.stopPropagation()}>
            {loadingDiff ? (
              <div className="diff-loading">
                <div className="spinner" />
                <p>加载差异...</p>
              </div>
            ) : (
              <DiffView
                filePath={selectedFile}
                diff={diff}
                onClose={closeDiffViewer}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
