// Pricing configuration per exam type (adjust as needed)
const prices = {
    "BECE": 19.00,
    "WASSCE": 22.00,
    "NOV/DEC": 22.00
};

const examTypeSelect = document.getElementById("examType");
const quantityInput = document.getElementById("quantity");
const pricePerPinSpan = document.getElementById("pricePerPin");
const totalPriceSpan = document.getElementById("totalPrice");
const resultsCheckerForm = document.getElementById("resultsCheckerForm");

// Update prices dynamically when exam type or quantity changes
function updatePricing() {
    const selectedExam = examTypeSelect.value;
    const qty = parseInt(quantityInput.value) || 1;
    const unitPrice = prices[selectedExam] || 19.00;
    const total = unitPrice * qty;

    pricePerPinSpan.textContent = unitPrice.toFixed(2);
    totalPriceSpan.textContent = total.toFixed(2);
}

examTypeSelect.addEventListener("change", updatePricing);
quantityInput.addEventListener("input", updatePricing);

// Handle form submission / Paystack integration
resultsCheckerForm.addEventListener("submit", function(e) {
    e.preventDefault();
    
    const email = document.getElementById("email").value;
    const phone = document.getElementById("phoneNumber").value;
    const totalAmount = parseFloat(totalPriceSpan.textContent);
    const examType = examTypeSelect.value;
    const quantity = quantityInput.value;

    // Placeholder for your Paystack popup integration
    alert(`Initiating Paystack payment of GHS ${totalAmount} for ${quantity} ${examType} checker(s).`);
    
    // TODO: Insert your Paystack Popups script here (e.g., PaystackPop.setup({...}))
});