document.addEventListener('DOMContentLoaded', () => {
    loadAfaRequests();
});

// Open/Close Modal handlers
function openAddAfaModal() {
    document.getElementById('afaModal').style.display = 'flex';
}

function closeAddAfaModal() {
    document.getElementById('afaModal').style.display = 'none';
}

// Save a new AFA registration
function submitNewAfa() {
    const name = document.getElementById('afaName').value.trim();
    const phone = document.getElementById('afaPhone').value.trim();
    const town = document.getElementById('afaTown').value.trim();
    const idNumber = document.getElementById('afaIdNumber').value.trim();

    if (!name || !phone || !town || !idNumber) {
        alert("Please fill in all required fields.");
        return;
    }

    const newEntry = {
        id: 'AFA-' + Math.floor(1000 + Math.random() * 9000),
        name: name,
        phone: phone,
        town: town,
        idNumber: idNumber,
        status: 'Pending', // Status options: Pending, Processing, Completed, Cancelled
        date: new Date().toLocaleDateString()
    };

    const afaList = JSON.parse(localStorage.getItem('skaitechAfaList')) || [];
    afaList.unshift(newEntry);
    localStorage.setItem('skaitechAfaList', JSON.stringify(afaList));

    alert("✅ AFA Registration submitted successfully!");
    closeAddAfaModal();
    
    // Clear fields
    document.getElementById('afaName').value = '';
    document.getElementById('afaPhone').value = '';
    document.getElementById('afaTown').value = '';
    document.getElementById('afaIdNumber').value = '';

    loadAfaRequests();
}

// Load and render AFA list from localStorage
function loadAfaRequests(filterQuery = '') {
    const afaList = JSON.parse(localStorage.getItem('skaitechAfaList')) || [];
    const container = document.getElementById('afaDataList');
    const emptyState = document.getElementById('emptyAfaState');

    container.innerHTML = '';

    // Filter based on search query (by phone, name, town, or ID)
    const filtered = afaList.filter(item => {
        const query = filterQuery.toLowerCase();
        return item.name.toLowerCase().includes(query) ||
               item.phone.toLowerCase().includes(query) ||
               item.town.toLowerCase().includes(query) ||
               item.idNumber.toLowerCase().includes(query) ||
               item.id.toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
        emptyState.style.display = 'block';
        container.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    container.style.display = 'flex';

    filtered.forEach(item => {
        // Status badge color coding
        let badgeColor = '#f59e0b'; // Pending (Yellow/Orange)
        if (item.status === 'Completed') badgeColor = '#10b981'; // Green
        else if (item.status === 'Processing') badgeColor = '#3b82f6'; // Blue
        else if (item.status === 'Cancelled') badgeColor = '#ef4444'; // Red

        const card = document.createElement('div');
        card.style.cssText = "background: #fdfdfd; border: 1px solid #eaeaea; padding: 15px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;";
        
        card.innerHTML = `
            <div>
                <div style="font-weight: 600; color: #1f2937; font-size: 15px; margin-bottom: 3px;">${item.name} <span style="font-size: 12px; color: #666; font-weight: normal;">(${item.id})</span></div>
                <div style="font-size: 13px; color: #4b5563; display: flex; gap: 15px; flex-wrap: wrap;">
                    <span><i class="fa-solid fa-phone"></i> ${item.phone}</span>
                    <span><i class="fa-solid fa-location-dot"></i> ${item.town}</span>
                    <span><i class="fa-solid fa-id-card"></i> ${item.idNumber}</span>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <span style="background: ${badgeColor}; color: white; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500;">${item.status}</span>
                <span style="font-size: 12px; color: #9ca3af;">${item.date}</span>
            </div>
        `;
        container.appendChild(card);
    });
}

// Live search tracker function
function filterAfaList() {
    const query = document.getElementById('afaSearchInput').value;
    loadAfaRequests(query);
}