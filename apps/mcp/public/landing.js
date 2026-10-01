// トップ（説明ページ）から、ホーム画面の PWA として開かれたとき・ログイン済みのときはアプリへ移る。
// 以前の PWA は起動 URL が / だったので、追加し直さなくても使えるようにする
;(function () {
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  var loggedIn = false
  try {
    var saved = JSON.parse(localStorage.getItem('mailhub.auth') || '{}')
    loggedIn = Boolean(saved.accessToken || saved.refreshToken)
  } catch {
    // 読めなくても説明ページを出すだけ
  }
  if (standalone || loggedIn) location.replace('/app/')
})()
