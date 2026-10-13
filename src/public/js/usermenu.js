(function () {
  var menu = document.querySelector('.usermenu');
  if (!menu) return;
  document.addEventListener('click', function (e) {
    if (!menu.contains(e.target)) menu.removeAttribute('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') menu.removeAttribute('open');
  });
})();
