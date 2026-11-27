// 관리자 모드: 설정(⚙) → 암호 4자리 → 관리자 화면(body.admin). 관람객 태블릿에서 조정 버튼을 숨기기 위한 잠금이에요.
// (웹 페이지 소스를 열면 알 수 있으니 보안 장치는 아니에요. 키오스크에서 관람객이 실수로 설정을 바꾸지 않게 하는 용도)
// 새로 고침하면 관람 모드로 돌아가고, 관리자 모드에서 10분 동안 아무것도 누르지 않아도 돌아가요(작업 중이면 예외).
const PIN = '4300';
const IDLE_MS = 10 * 60 * 1000;

// onChange(on): 모드가 바뀔 때. rootFor(): 암호 창을 붙일 곳 (AR 중에는 화면 위 층(dom-overlay)이어야 보임). isBusy(): 자동으로 나가면 안 될 때
export function createAdminGate({ onChange = () => {}, rootFor = () => document.body, isBusy = () => false } = {}) {
  let admin = false, typed = '', lastTouch = Date.now();
  const set = (on) => {
    admin = on;
    document.body.classList.toggle('admin', on);
    onChange(on);
  };

  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.hidden = true;
  back.dataset.noselect = '';
  back.innerHTML = `<div class="pin-modal glass solid" role="dialog" aria-modal="true" aria-labelledby="pinTitle" lang="ko">
    <h2 id="pinTitle">관리자 모드</h2>
    <p>암호 4자리를 눌러 주세요</p>
    <div class="pin-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <p class="pin-msg" aria-live="polite"></p>
    <div class="keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
      <button type="button" class="fn" data-k="cancel">취소</button>
      <button type="button" data-k="0">0</button>
      <button type="button" class="fn" data-k="back" aria-label="한 글자 지우기">지우기</button>
    </div>
  </div>`;
  const dots = back.querySelector('.pin-dots'), msg = back.querySelector('.pin-msg');
  const render = () => dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < typed.length));

  function open() {
    typed = ''; msg.textContent = ''; dots.classList.remove('shake'); render();
    const root = rootFor();
    if (back.parentNode !== root) root.appendChild(back);
    back.hidden = false;
  }
  function close() { back.hidden = true; }
  function enter(pin) {
    if (String(pin) === PIN) { close(); set(true); return true; }
    return false;
  }
  function exit() { set(false); }

  back.addEventListener('click', (e) => {
    if (e.target === back) { close(); return; } // 바깥을 누르면 닫기
    const k = e.target.closest('button') && e.target.closest('button').dataset.k;
    if (!k) return;
    if (k === 'cancel') { close(); return; }
    if (k === 'back') { typed = typed.slice(0, -1); msg.textContent = ''; render(); return; }
    if (typed.length >= 4) return;
    typed += k; render();
    if (typed.length === 4) {
      if (enter(typed)) return;
      msg.textContent = '암호가 맞지 않아요';
      dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
      setTimeout(() => { typed = ''; render(); }, 450);
    }
  });

  // 관리자 모드로 둔 채 자리를 떠도 10분 뒤에는 관람 모드로
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);
  setInterval(() => { if (admin && Date.now() - lastTouch > IDLE_MS && !isBusy()) set(false); }, 30000);

  // 시험용: 페이지를 열기 전에 window.__raimAutoAdmin에 암호를 넣어 두면 바로 관리자 모드 (암호가 맞아야 함)
  if (typeof window !== 'undefined' && window.__raimAutoAdmin) queueMicrotask(() => enter(window.__raimAutoAdmin));

  return { open, close, enter, exit, get on() { return admin; } };
}
