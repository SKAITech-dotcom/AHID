// logout.js - Handles dynamic agent avatar initialization and logout dropdown functionality

document.addEventListener('DOMContentLoaded', () => {
    const avatarElement = document.getElementById('userAvatarInitials');
    
    if (avatarElement) {
        // Retrieve agent name from storage
        let storedName = '';
        try {
            storedName = localStorage.getItem('currentAgentName') || sessionStorage.getItem('currentAgentName');
        } catch (e) {
            storedName = '';
        }
        
        if (!storedName) {
            storedName = 'Valued Agent';
        }

        // Extract first letter of first name and first letter of second name
        const nameParts = storedName.trim().split(/\s+/);
        let initials = '';

        if (nameParts.length >= 2) {
            initials = nameParts[0].charAt(0) + nameParts[1].charAt(0);
        } else if (nameParts.length === 1 && nameParts[0].length > 0) {
            initials = nameParts[0].slice(0, 2);
        } else {
            initials = 'AG';
        }

        // Render initials and attach the logout dropdown directly inside the avatar element
        avatarElement.style.position = 'relative';
        avatarElement.style.cursor = 'pointer';
        avatarElement.innerHTML = `
            <div id="avatarClickTarget" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                ${initials.toUpperCase()}
            </div>
            
            <div id="logoutDropdown" style="display: none; position: absolute; right: 0; top: 45px; background: white; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border-radius: 8px; width: 130px; z-index: 1000; overflow: hidden; text-align: left;">
                <a href="#" id="logoutButtonLink" style="display: flex; align-items: center; gap: 8px; padding: 10px 14px; color: #dc2626; text-decoration: none; font-size: 13px; font-weight: 500; background: #fef2f2;">
                    <i class="fa-solid fa-right-from-bracket"></i> Logout
                </a>
            </div>
        `;

        // Toggle dropdown on click
        const clickTarget = document.getElementById('avatarClickTarget');
        const dropdown = document.getElementById('logoutDropdown');
        
        clickTarget.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
        });

        // Handle logout action
        const logoutLink = document.getElementById('logoutButtonLink');
        logoutLink.addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.clear();
            sessionStorage.clear();
            window.location.href = 'login.html';
        });

        // Close dropdown when clicking outside
        window.addEventListener('click', (e) => {
            if (dropdown && !avatarElement.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });
    }
});