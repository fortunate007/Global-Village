(function () {
  if (typeof io === 'undefined') return;
  const socket = io();

  const stack = document.createElement('div');
  stack.style.cssText =
    'position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:9999;max-width:320px';
  document.body.appendChild(stack);

  function setBadge(count) {
    document.querySelectorAll('[data-notification-badge]').forEach((el) => {
      el.textContent = count > 0 ? '(' + count + ')' : '';
    });
  }

  function toast(n) {
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText =
      'padding:12px 16px;background:#222;color:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    const link = document.createElement('a');
    link.href = n.href;
    link.textContent = n.text;
    link.style.color = '#fff';
    box.appendChild(link);
    stack.appendChild(box);
    setTimeout(() => box.remove(), 6000);
  }

  socket.on('notification:new', (n) => {
    setBadge(n.unread);
    toast(n);
  });
})();
