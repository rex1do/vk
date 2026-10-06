const $ = (id) => document.getElementById(id);

const SECTION_TITLES = {
  home: 'ВК Музыка',
  my: 'Моя музыка',
  recoms: 'Рекомендации',
  playlists: 'Плейлисты',
  chart: 'Чарт',
  new: 'Новинки',
};

// Какой раздел открыт — по адресу страницы ВК
function sectionFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/^\/(audio|music)/.test(u.pathname)) return null;
    if (u.searchParams.get('q')) return 'search';
    const section = u.searchParams.get('section');
    const block = u.searchParams.get('block');
    if (section === 'all') return 'my';
    if (section === 'recoms') return 'recoms';
    if (section === 'playlists') return 'playlists';
    if (block === 'chart') return 'chart';
    if (block === 'new_songs') return 'new';
    if (u.pathname === '/audio' && !section && !block) return 'home';
  } catch {}
  return null;
}

document.querySelectorAll('[data-section]').forEach((btn) => {
  btn.addEventListener('click', () => window.vkp.navigate(btn.dataset.section));
});
document.querySelectorAll('[data-media]').forEach((btn) => {
  btn.addEventListener('click', () => window.vkp.media(btn.dataset.media));
});
$('back').addEventListener('click', () => window.vkp.history('back'));
$('forward').addEventListener('click', () => window.vkp.history('forward'));
$('reload').addEventListener('click', () => window.vkp.history('reload'));
$('login-btn').addEventListener('click', () => window.vkp.login());
window.vkp.onAuthState(({ loggedIn }) => {
  $('login').hidden = loggedIn;
});
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.vkp.search($('search').value);
});

window.vkp.onFocusSearch(() => {
  $('search').focus();
  $('search').select();
});

window.vkp.onNavState((state) => {
  const section = sectionFromUrl(state.url);
  document.querySelectorAll('[data-section]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
  let title = 'ВКонтакте';
  if (section === 'search') {
    const q = new URL(state.url).searchParams.get('q');
    title = `Поиск: ${q}`;
    $('search').value = q;
  } else if (section) {
    title = SECTION_TITLES[section];
  } else if (/^https:\/\/(id\.)?vk\.(com|ru)\/(login|auth|join)?/.test(state.url) && /login|auth|join|id\.vk/.test(state.url)) {
    title = 'Вход во ВКонтакте';
  }
  $('title').textContent = title;
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('spinner').classList.toggle('on', state.loading);
});

window.vkp.onNowPlaying((info) => {
  const now = $('now');
  now.classList.toggle('idle', !info);
  now.classList.toggle('playing', Boolean(info && info.playing));
  $('now-title').textContent = info ? info.title : 'Ничего не играет';
  $('now-artist').textContent = info ? info.artist || '' : 'Включите любой трек справа';
  $('now-title').title = $('now-title').textContent;
  const img = $('cover-img');
  if (info && info.artwork) {
    if (img.src !== info.artwork) img.src = info.artwork;
    $('cover').classList.add('has-art');
  } else {
    $('cover').classList.remove('has-art');
    img.removeAttribute('src');
  }
});

// macOS: кнопки окна слева, а не справа
if (window.vkp.platform === 'darwin') document.querySelector('.brand').style.paddingLeft = '84px';

$('now').classList.add('idle');
window.vkp.ready();
