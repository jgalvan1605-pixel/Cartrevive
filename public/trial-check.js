(async function() {
  const token = localStorage.getItem('token');
  if (!token) return;

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const user = await res.json();
    if (!user || !user.subscriptionInfo) return;

    const info = user.subscriptionInfo;

    // Si expiró y no está en billing.html, redirige al Paywall
    if (!info.isAllowed && !window.location.pathname.includes('billing.html')) {
      window.location.href = '/billing.html?expired=true';
      return;
    }

    // Si está en período de prueba, inserta el banner superior
    if (info.status === 'TRIALING' && !window.location.pathname.includes('billing.html')) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background: #f59e0b; color: #000; font-weight: 600; font-size: 0.85rem; padding: 0.5rem 1rem; text-align: center; display: flex; justify-content: center; align-items: center; gap: 1rem; z-index: 9999;';
      banner.innerHTML = `
        <span>⏳ Estás en tu <b>prueba gratuita de 15 días</b> (Te quedan <b>${info.daysLeft} días</b>).</span>
        <a href="/billing.html" style="background: #000; color: #fff; padding: 0.25rem 0.75rem; border-radius: 6px; text-decoration: none; font-size: 0.8rem;">Activar Plan</a>
      `;
      document.body.prepend(banner);
    }
  } catch (e) {
    console.error('Error comprobando estado de prueba:', e);
  }
})();
