import { Header } from '../components/Header.jsx';
import { BASE } from '../lib/env.js';
import { linkHandler } from '../lib/router.js';

export function NotFound() {
  return (
    <div class="screen screen--paper">
      <Header />
      <main class="wrap content">
        <h1 class="page-title display">Такой страницы нет</h1>
        <p class="lead">Возможно, ссылка устарела. Чтобы начать игру, отсканируйте QR-код на столе.</p>
        <a class="btn btn--primary btn--block" href={BASE} onClick={linkHandler}>
          На главную
        </a>
      </main>
    </div>
  );
}
