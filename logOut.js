import { supabase } from './supabaseClient.js';

function clearUserSession() {
    try {
        localStorage.clear();
    } catch (err) {
        console.warn('Failed to clear localStorage:', err);
    }

    try {
        sessionStorage.clear();
    } catch (err) {
        console.warn('Failed to clear sessionStorage:', err);
    }

    window.location.href = 'login.html';
}

function showCredentialsModal() {
    let modal = document.getElementById('agentCredentialsModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'agentCredentialsModal';
        modal.style.position = 'fixed';
        modal.style.inset = '0';
        modal.style.background = 'rgba(15, 23, 42, 0.55)';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.zIndex = '2000';
        modal.innerHTML = `
            <div style="background: white; width: min(92vw, 420px); border-radius: 14px; padding: 24px; box-shadow: 0 20px 45px rgba(15, 23, 42, 0.25);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;">
                    <h3 style="margin: 0; font-size: 1.1rem; color: #1f2937;">Update credentials</h3>
                    <button type="button" id="closeCredentialsModal" style="background: transparent; border: none; font-size: 1.3rem; cursor: pointer; color: #6b7280;">×</button>
                </div>

                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <label style="font-size: 0.8rem; color: #4b5563; font-weight: 600;">New email (optional)</label>
                    <input id="agentNewEmail" type="email" placeholder="newemail@example.com" style="padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.95rem;" />

                    <label style="font-size: 0.8rem; color: #4b5563; font-weight: 600;">New password (optional)</label>
                    <input id="agentNewPassword" type="password" placeholder="Minimum 6 characters" style="padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.95rem;" />

                    <label style="font-size: 0.8rem; color: #4b5563; font-weight: 600;">Confirm password</label>
                    <input id="agentConfirmPassword" type="password" placeholder="Repeat new password" style="padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.95rem;" />

                    <button id="saveCredentialsBtn" type="button" style="margin-top: 8px; background: #2563eb; color: white; border: none; padding: 11px 14px; border-radius: 8px; cursor: pointer; font-weight: 700;">Save changes</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('closeCredentialsModal').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (event) => {
            if (event.target === modal) modal.remove();
        });

        document.getElementById('saveCredentialsBtn').addEventListener('click', async () => {
            const emailValue = document.getElementById('agentNewEmail').value.trim();
            const passwordValue = document.getElementById('agentNewPassword').value;
            const confirmPasswordValue = document.getElementById('agentConfirmPassword').value;

            if (!emailValue && !passwordValue) {
                alert('Enter a new email or password before saving.');
                return;
            }

            if (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
                alert('Please enter a valid email address.');
                return;
            }

            if (passwordValue || confirmPasswordValue) {
                if (passwordValue.length < 6) {
                    alert('Password must be at least 6 characters long.');
                    return;
                }

                if (passwordValue !== confirmPasswordValue) {
                    alert('Passwords do not match.');
                    return;
                }
            }

            try {
                const { error } = await supabase.auth.updateUser({
                    email: emailValue || undefined,
                    password: passwordValue || undefined,
                });

                if (error) {
                    throw error;
                }

                modal.remove();
                alert('Credentials updated successfully. Please sign in again to continue.');

                try {
                    await supabase.auth.signOut();
                } catch (signOutErr) {
                    console.warn('Sign-out after update failed:', signOutErr);
                }

                clearUserSession();
            } catch (err) {
                console.error('updateUser failed:', err);
                alert(err?.message || 'Unable to update credentials right now.');
            }
        });
    }

    modal.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
    const drawer = document.getElementById('sideDrawer');
    if (!drawer) return;

    const communityLink = Array.from(drawer.querySelectorAll('a')).find((link) => {
        const text = (link.textContent || '').toLowerCase();
        return text.includes('community') || text.includes('whatsapp');
    });

    if (!communityLink) return;

    const actionsWrap = document.createElement('div');
    actionsWrap.style.marginTop = '8px';
    actionsWrap.style.borderTop = '1px solid #e5e7eb';
    actionsWrap.style.paddingTop = '10px';

    const changeBtn = document.createElement('button');
    changeBtn.type = 'button';
    changeBtn.innerHTML = '<i class="fa-solid fa-user-gear"></i> Change credentials';
    changeBtn.style.cssText = 'display:flex; align-items:center; gap:8px; width:100%; background:transparent; border:none; color:#1f2937; text-align:left; padding:10px 18px; font-size:14px; font-weight:500; cursor:pointer;';
    changeBtn.addEventListener('click', () => {
        showCredentialsModal();
    });

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Logout';
    logoutBtn.style.cssText = 'display:flex; align-items:center; gap:8px; width:100%; background:transparent; border:none; color:#dc2626; text-align:left; padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer;';
    logoutBtn.addEventListener('click', async () => {
        try {
            await supabase.auth.signOut();
        } catch (err) {
            console.warn('Supabase sign-out notice:', err);
        }
        clearUserSession();
    });

    actionsWrap.appendChild(changeBtn);
    actionsWrap.appendChild(logoutBtn);
    drawer.appendChild(actionsWrap);
});