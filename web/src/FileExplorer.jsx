import React, { useState, useEffect } from 'react';
import { api } from './api.js';

// 文件图标
function FileIcon({ type, name }) {
  if (type === 'directory') return '📁';

  const ext = name.split('.').pop();
  const iconMap = {
    js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', java: '☕', go: '🔵', rs: '🦀',
    yml: '⚙️', yaml: '⚙️', xml: '📰', txt: '📄',
  };
  return iconMap[ext] || '📄';
}

// 文件树节点
function TreeNode({ node, level, onFileClick, expandedPaths, onToggleExpand }) {
  const isExpanded = expandedPaths.has(node.path);
  const hasChildren = node.type === 'directory' && node.children?.length > 0;

  const handleClick = () => {
    if (node.type === 'directory') {
      onToggleExpand(node.path);
    } else {
      onFileClick(node.path);
    }
  };

  return (
    <div className="tree-node-wrapper">
      <div
        className="tree-node"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span className="tree-arrow">{isExpanded ? '▼' : '▶'}</span>
        )}
        {!hasChildren && node.type === 'directory' && <span className="tree-arrow-placeholder" />}
        <FileIcon type={node.type} name={node.name} />
        <span className="tree-node-name">{node.name}</span>
        {node.type === 'file' && node.size && (
          <span className="tree-node-size">{formatSize(node.size)}</span>
        )}
      </div>
      {isExpanded && hasChildren && (
        <div className="tree-children">
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              onFileClick={onFileClick}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// 文件内容查看器
function FileViewer({ filePath, content, onClose }) {
  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <span className="file-viewer-path">{filePath}</span>
        <button className="file-viewer-close" onClick={onClose}>×</button>
      </div>
      <pre className="file-viewer-content"><code>{content}</code></pre>
    </div>
  );
}

export default function FileExplorer({ cwd }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedPaths, setExpandedPaths] = useState(new Set(['.']));
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    if (!cwd) return;

    setLoading(true);
    setError(null);

    fetch('/api/files/tree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setTree(data.tree);
        setLoading(false);
      })
      .catch(err => {
        setError(String(err.message || err));
        setLoading(false);
      });
  }, [cwd]);

  const toggleExpand = (path) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleFileClick = async (filePath) => {
    setSelectedFile(filePath);
    setLoadingFile(true);
    setFileContent(null);

    try {
      const res = await fetch('/api/files/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath, cwd }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFileContent(data.content);
    } catch (err) {
      setFileContent(`错误：${err.message || err}`);
    } finally {
      setLoadingFile(false);
    }
  };

  const closeFileViewer = () => {
    setSelectedFile(null);
    setFileContent(null);
  };

  if (loading) {
    return (
      <div className="file-explorer">
        <div className="file-explorer-loading">
          <div className="spinner" />
          <p>加载文件树...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-explorer">
        <div className="file-explorer-error">
          <p>无法加载文件树</p>
          <p className="muted small">{error}</p>
        </div>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="file-explorer">
        <div className="file-explorer-empty">
          <p className="muted">选择一个会话以查看其文件</p>
        </div>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-cwd" title={cwd}>{cwd}</span>
      </div>
      <div className="file-tree">
        <TreeNode
          node={tree}
          level={0}
          onFileClick={handleFileClick}
          expandedPaths={expandedPaths}
          onToggleExpand={toggleExpand}
        />
      </div>
      {selectedFile && (
        <div className="file-viewer-overlay" onClick={closeFileViewer}>
          <div className="file-viewer-modal" onClick={(e) => e.stopPropagation()}>
            {loadingFile ? (
              <div className="file-viewer-loading">
                <div className="spinner" />
                <p>加载文件内容...</p>
              </div>
            ) : (
              <FileViewer
                filePath={selectedFile}
                content={fileContent}
                onClose={closeFileViewer}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
