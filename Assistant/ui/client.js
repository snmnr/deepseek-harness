/**
 * mem0-dsh-ui browser bundle.
 *
 * Hand-written closure-factory artifact matching the client-modules Lazy-CJS
 * wire (see packages/client/tsdown.client.ts banner/footer shape): the bundle
 * registers a factory on window.__ModuleLoader__; the loader materializes it
 * with a synchronous `require` resolving the platform baseline (react,
 * react/jsx-runtime, @deepseek-ai/cordis, @deepseek-ai/dsh-client-ui-slots...).
 * No build step: JSX is precompiled to React.createElement calls.
 *
 * Registers:
 *   1. A right-sidebar tab type `mem0` (extension band) whose body reads
 *      `notes/_state/mem0-status.json` in the session workspace through
 *      useResource('file') — buffer depth, pause state, guard level, last
 *      flush — refreshing via the file provider's change stream.
 *   2. A `conversation.session.header.actions` entry rendering a light status
 *      dot (green live / amber paused / gray ended) that opens the tab on click.
 *
 * The status file is written by the host-side mem0-dsh-bridge plugin.
 */
window.__ModuleLoader__.load({ id: 'mem0-dsh-ui', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require('react');
  var createElement = React.createElement;
  // Slot contracts are type-only; at runtime registration goes through ctx.

  /** Workspace-relative path of the status file (written by the bridge). */
  var STATUS_REL = 'notes/_state/mem0-status.json';

  function statusValueOf(snapshot) {
    if (!snapshot || snapshot.status !== 'live' || !snapshot.value) return undefined;
    return snapshot.value;
  }

  /** Derive the panel model from a status JSON text/bytes value. */
  function parseStatus(value) {
    // The file resource value carries metadata; content arrives as text when
    // the owner supplies it, otherwise read via remote — the value we get from
    // useResource is { absolutePath, version, bytes? } (metadata only).
    // Reading text requires the workspaceFiles remote, which is available via
    // ctx.remote in apply; the body receives it through inject.
    return undefined;
  }

  // ------------------------------------------------------------------
  // Right-sidebar tab body
  // ------------------------------------------------------------------

  function StatusRow(label, value, danger) {
    return createElement('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' } },
      createElement('span', { style: { opacity: 0.65 } }, label),
      createElement('span', { style: danger ? { color: '#d03050' } : undefined }, value));
  }

  /**
   * The mem0 tab body. Props (derived shares for `sidebar.right.pane.tab`):
   * useTabInfo (framework-injected), useResource (global standard), sessionId
   * (session standard), plus `readStatus` from the registration inject face,
   * which reads the status file text through remote.workspaceFiles.read.
   */
  function Mem0PanelBody(props) {
    var tabInfo = props.useTabInfo();
    var sessionId = props.sessionId;
    var _a = React.useState({ status: 'loading', data: undefined }), state = _a[0], setState = _a[1];
    React.useEffect(function () {
      var alive = true;
      props.readStatus(sessionId).then(function (data) {
        if (alive) setState({ status: 'live', data: data });
      }).catch(function () {
        if (alive) setState({ status: 'failed', data: undefined });
      });
      return function () { alive = false; };
    }, [sessionId, props.readStatus]);
    // Poll every 15s as a belt-and-braces refresh beside the change stream
    // (the change channel is the primary refresh; the poll covers hosts where
    // the file provider's watch is unavailable).
    React.useEffect(function () {
      var timer = setInterval(function () {
        props.readStatus(sessionId).then(function (data) {
          setState({ status: 'live', data: data });
        }).catch(function () { /* keep last state */ });
      }, 15000);
      return function () { clearInterval(timer); };
    }, [sessionId, props.readStatus]);

    if (state.status === 'loading') {
      return createElement('div', { style: { padding: 12, opacity: 0.6 } }, 'mem0 状态加载中…');
    }
    if (state.status === 'failed' || !state.data) {
      return createElement('div', { style: { padding: 12, opacity: 0.6 } },
        'mem0 状态文件不可读（尚未写入或项目目录不可写）。bridge 首个 turn 边界后重试。');
    }
    var d = state.data;
    var paused = d.paused === true;
    var ended = d.ended === true;
    var guard = d.guardLevel;
    return createElement('div', { style: { padding: 12, fontSize: 13, lineHeight: 1.5 } },
      createElement('div', { style: { fontWeight: 600, marginBottom: 6 } },
        'mem0 记忆桥', paused ? '（已暂停）' : ended ? '（会话已结束）' : ''),
      StatusRow('服务', String(d.api_url || '-')),
      StatusRow('用户', String(d.user_id || '-')),
      StatusRow('当前会话缓冲', String(d.sessionPending != null ? d.sessionPending : d.pending_buffers ? d.pending_buffers.reduce(function (n, b) { return n + (b.pending || 0); }, 0) : 0) + ' 条'),
      StatusRow('暂停', paused ? '是' : '否', paused),
      StatusRow('上下文警卫', guard ? String(guard) : '正常', guard === 'critical' || guard === 'urgent'),
      StatusRow('累计 tokens', d.tokens != null ? String(d.tokens) : '-'),
      d.contextTokens != null ? StatusRow('上下文占用', String(d.contextTokens)) : null,
      d.last_flush_at ? StatusRow('最近落盘', new Date(d.last_flush_at).toLocaleString()) : null,
      StatusRow('数据目录', String(d.data_dir || '-')),
      createElement('div', { style: { marginTop: 8, opacity: 0.55, fontSize: 12 } },
        '更新于 ' + (d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : '-')),
      tabInfo && tabInfo.tab ? null : null);
  }

  // ------------------------------------------------------------------
  // Session header status dot
  // ------------------------------------------------------------------

  function Mem0HeaderDot(props) {
    var sessionId = props.sessionId;
    // undefined = loading, null = no data, true/false = paused state.
    var _a = React.useState(undefined), paused = _a[0], setPaused = _a[1];
    React.useEffect(function () {
      var alive = true;
      var load = function () {
        props.readStatus(sessionId).then(function (d) {
          if (alive) setPaused(d && d.paused === true);
        }).catch(function () { if (alive) setPaused(null); });
      };
      load();
      var timer = setInterval(load, 20000);
      return function () { alive = false; clearInterval(timer); };
    }, [sessionId, props.readStatus]);
    // null (no data) renders a dim dot so the plugin is visibly alive even
    // before the bridge writes its first status file.
    if (paused === undefined) return null;
    var label = paused === null ? 'mem0（状态文件未生成）' : paused ? 'mem0 采集已暂停' : 'mem0 采集中';
    var color = paused === null ? '#9a9a9a' : paused ? '#c78a1d' : '#2e8f4e';
    var text = paused === null ? '○ mem0' : paused ? '⏸ mem0' : '● mem0';
    return createElement('button', {
      type: 'button', title: label, 'aria-label': 'mem0 status',
      onClick: function () { if (props.openMem0Tab) props.openMem0Tab(); },
      style: { border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 4px', fontSize: 12, color: color },
    }, text);
  }

  // ------------------------------------------------------------------
  // apply: registration
  // ------------------------------------------------------------------

  var TAB_ID = 'mem0-dsh-ui';
  var TAB_KIND = 'mem0';

  function apply(ctx) {
    function readStatus(sessionId) {
      return ctx.remote.workspaceFiles.read(sessionId, STATUS_REL, { offset: 1, limit: 200 }, undefined)
        .then(function (r) {
          if (!r.ok) throw new Error((r.error && r.error.message) || 'read failed');
          return JSON.parse(r.value.text);
        });
    }

    ctx.effect(function () {
      return ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: function () { return 'mem0'; },
      });
    }, 'mem0-dsh-ui: tab type');

    ctx.effect(function () {
      return ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          inject: function (sessionId) {
            return {
              readStatus: function () { return readStatus(sessionId); },
            };
          },
        }, Mem0PanelBody);
      });
    }, 'mem0-dsh-ui: tab body');

    // Header actions: registered at apply top level like ui-jobs (the list
    // slot takes `id`, not `key`).
    ctx.slots.inject('conversation.session.header.actions', function () {
      return ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: TAB_ID,
        order: 90,
        inject: function (sessionId) {
          return {
            readStatus: function () { return readStatus(sessionId); },
            openMem0Tab: function () { ctx.sidebarRight.openTabIn(sessionId, TAB_KIND); },
          };
        },
      }, Mem0HeaderDot);
    });
  }

  exports.apply = apply;
  // Cordis service dependencies of apply: without this declaration the runner
  // refuses ctx property access ("cannot get property ... without inject").
  // Remote namespaces must each be declared individually (see ui-reference:
  // 'remote' + 'remote.fileReferences').
  exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles'];
  return module.exports;
} });
