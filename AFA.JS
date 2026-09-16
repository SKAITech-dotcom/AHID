import { supabase } from './supabaseClient.js';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// Handle New Registration Submission
function submitRegistration() {
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const town = document.getElementById('regTown').value.trim();
    const idType = document.getElementById('regIdType').value;
    const idNumber = document.getElementById('regIdNumber').value.trim();

    if (!name || !phone || !town || !idType || !idNumber) {
        alert('Please fill out all registration fields.');
        return;
    }

    let records = JSON.parse(localStorage.getItem('skaitech_afa')) || [];

    const newRecord = {
        fullName: name,
        phone: phone,
        town: town,
        idNum: `${idType} (${idNumber})`,
        amount: "GHS 8.00",
        type: "AFA",
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        status: "PENDING / PROCESSING"
    };

    records.unshift(newRecord);
    localStorage.setItem('skaitech_afa', JSON.stringify(records));

    alert('AFA Registration submitted successfully! You can now track your status below.');
    
    // Clear inputs
    document.getElementById('regName').value = '';
    document.getElementById('regPhone').value = '';
    document.getElementById('regTown').value = '';
    document.getElementById('regIdType').value = '';
    document.getElementById('regIdNumber').value = '';
}

// Handle Status Tracking Lookup
function trackAfa() {
    const inputField = document.getElementById('afaQuery');
    const resultBox = document.getElementById('afaResult');

    if (!inputField || !resultBox) return;

    const query = inputField.value.trim().toLowerCase();

    if (!query) {
        alert('Please enter your phone number or ID number.');
        return;
    }

    const records = JSON.parse(localStorage.getItem('skaitech_afa')) || [];

    if (records.length === 0) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = `<p style="color: #b45309; font-weight: 600; margin: 0;">No AFA records found in the system yet. Please register above first!</p>`;
        return;
    }

    const found = records.find(item => 
        item.phone.toLowerCase().includes(query) || 
        item.idNum.toLowerCase().includes(query) || 
        item.fullName.toLowerCase().includes(query)
    );

    if (!found) {
        resultBox.style.display = 'block';
        resultBox.innerHTML = `<p style="color: #b45309; font-weight: 600; margin: 0;">No active AFA registration matched: "${escapeHtml(query)}"</p>`;
        return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = `
        <div style="font-size: 0.9rem;">
            <div style="font-weight: 800; color: #b45309; margin-bottom: 10px; font-size: 1rem;">Registration Found!</div>
            
            <div class="field-label">FULL NAME</div>
            <div class="field-val">${escapeHtml(found.fullName)}</div>

            <div class="field-label">PHONE NUMBER</div>
            <div class="field-val">${escapeHtml(found.phone)}</div>

            <div class="field-label">TOWN</div>
            <div class="field-val">${escapeHtml(found.town)}</div>

            <div class="field-label">ID NUMBER</div>
            <div class="field-val">${escapeHtml(found.idNum)}</div>

            <div class="field-label">REGISTRATION STATUS</div>
            <div style="display: inline-block; background: #d97706; color: white; padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 0.8rem; margin-top: 4px;">
                ${escapeHtml(found.status)}
            </div>
        </div>
    `;
}

// Bind AFA functions to window for HTML onclick attributes
window.submitRegistration = submitRegistration;
window.trackAfa = trackAfa;