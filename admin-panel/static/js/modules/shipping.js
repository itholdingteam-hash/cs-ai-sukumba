// ================================================================
// SHIPPING RATES
// ================================================================

var shippingRegions = [];
var shippingRegionsPromise = null;

function normalizeRegionName(value) {
  return String(value || "").trim().toLowerCase();
}

async function loadShippingRegions() {
  if (shippingRegions.length) return shippingRegions;
  if (!shippingRegionsPromise) {
    shippingRegionsPromise = fetch("/static/data/regions-id.json", { cache: "force-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("Gagal memuat data wilayah");
        return res.json();
      })
      .then(function (data) {
        shippingRegions = data.regions || [];
        return shippingRegions;
      });
  }
  return shippingRegionsPromise;
}

function optionHtml(value, label, selected) {
  return '<option value="' + escHtml(value) + '"' + (selected ? " selected" : "") + ">" + escHtml(label) + "</option>";
}

function findRegionByName(items, value) {
  var key = normalizeRegionName(value);
  return (items || []).find(function (item) {
    return normalizeRegionName(item.name) === key;
  }) || null;
}

function selectedProvince(selectId) {
  var value = document.getElementById(selectId).value;
  return findRegionByName(shippingRegions, value);
}

function selectedCity(province, selectId) {
  var value = document.getElementById(selectId).value;
  return province ? findRegionByName(province.cities, value) : null;
}

function formatPlainRupiah(value) {
  return String(value || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function estimateShippingForRegion(province, city) {
  if (!province || !city) return null;
  var provinceCode = String(province.code || "");
  var cityCode = String(city.code || "");
  var cityName = normalizeRegionName(city.name);
  var rate = { cost: 32000, days: "4-7 hari", zone: "Indonesia" };

  if (provinceCode === "52") {
    rate = { cost: 16000, days: "2-4 hari", zone: "NTB" };
    if (/sumbawa|bima|dompu/.test(cityName)) rate = { cost: 12000, days: "1-3 hari", zone: "Sumbawa/sekitar" };
  } else if (provinceCode === "51" || provinceCode === "53") {
    rate = { cost: 20000, days: "3-5 hari", zone: "Bali/NTT" };
  } else if (/^3/.test(provinceCode) || provinceCode === "36") {
    rate = { cost: 24000, days: "3-6 hari", zone: "Jawa" };
  } else if (/^(1|2)/.test(provinceCode)) {
    rate = { cost: 33000, days: "4-7 hari", zone: "Sumatra" };
  } else if (/^6/.test(provinceCode)) {
    rate = { cost: 36000, days: "4-8 hari", zone: "Kalimantan" };
  } else if (/^7/.test(provinceCode)) {
    rate = { cost: 38000, days: "4-8 hari", zone: "Sulawesi" };
  } else if (/^8/.test(provinceCode)) {
    rate = { cost: 48000, days: "5-10 hari", zone: "Maluku" };
  } else if (/^9/.test(provinceCode)) {
    rate = { cost: 65000, days: "7-14 hari", zone: "Papua" };
  }

  if (/^31\.|kota jakarta/.test(cityCode + " " + cityName)) {
    rate = { cost: 26000, days: "3-6 hari", zone: "DKI Jakarta" };
  }
  return rate;
}

function applyShippingEstimate(provinceSelectId, citySelectId, costInputId, daysInputId, hintId, force) {
  var province = selectedProvince(provinceSelectId);
  var city = selectedCity(province, citySelectId);
  var costInput = document.getElementById(costInputId);
  var daysInput = document.getElementById(daysInputId);
  var hint = document.getElementById(hintId);
  var estimate = estimateShippingForRegion(province, city);

  if (!costInput) return;
  if (!estimate) {
    if (hint) hint.textContent = "Pilih provinsi dan kab/kota untuk estimasi otomatis.";
    return;
  }

  if (force || !costInput.value.trim() || costInput.dataset.autoEstimate === "1") {
    costInput.value = String(estimate.cost);
    costInput.dataset.autoEstimate = "1";
  }
  if (daysInput && (force || !daysInput.value.trim() || daysInput.dataset.autoEstimate === "1")) {
    daysInput.value = estimate.days;
    daysInput.dataset.autoEstimate = "1";
  }
  if (hint) {
    hint.textContent = "Estimasi otomatis zona " + estimate.zone + ": Rp " + formatPlainRupiah(estimate.cost) + ". Bisa diubah jika tarif kurir berbeda.";
  }
}

function markManualShippingInput(inputId) {
  var input = document.getElementById(inputId);
  if (input && !input.dataset.manualBound) {
    input.dataset.manualBound = "1";
    input.addEventListener("input", function () {
      input.dataset.autoEstimate = "0";
    });
  }
}

function populateProvinceSelect(selectId, selectedValue) {
  var select = document.getElementById(selectId);
  if (!select) return;
  var selectedKey = normalizeRegionName(selectedValue);
  select.innerHTML = optionHtml("", "Pilih provinsi", !selectedKey) + shippingRegions.map(function (province) {
    return optionHtml(province.name, province.name, normalizeRegionName(province.name) === selectedKey);
  }).join("");
}

function populateCitySelect(provinceSelectId, citySelectId, selectedValue) {
  var province = selectedProvince(provinceSelectId);
  var select = document.getElementById(citySelectId);
  if (!select) return null;
  var selectedKey = normalizeRegionName(selectedValue);
  if (!province) {
    select.innerHTML = optionHtml("", "Pilih kab/kota", true);
    select.disabled = true;
    return null;
  }
  select.disabled = false;
  select.innerHTML = optionHtml("", "Pilih kab/kota", !selectedKey) + province.cities.map(function (city) {
    return optionHtml(city.name, city.name, normalizeRegionName(city.name) === selectedKey);
  }).join("");
  return selectedCity(province, citySelectId);
}

function populateDistrictSelect(provinceSelectId, citySelectId, districtSelectId, selectedValue) {
  var province = selectedProvince(provinceSelectId);
  var city = selectedCity(province, citySelectId);
  var select = document.getElementById(districtSelectId);
  if (!select) return;
  var selectedKey = normalizeRegionName(selectedValue);
  if (!city) {
    select.innerHTML = optionHtml("", "Semua kecamatan", true);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = optionHtml("", "Semua kecamatan", !selectedKey) + city.districts.map(function (district) {
    return optionHtml(district.name, district.name, normalizeRegionName(district.name) === selectedKey);
  }).join("");
}

function fillGenerateDistricts() {
  var province = selectedProvince("ship-gen-province");
  var city = selectedCity(province, "ship-gen-city");
  var target = document.getElementById("ship-gen-districts");
  if (!target) return;
  target.value = city ? city.districts.map(function (district) { return district.name; }).join("\n") : "";
}

function bindShippingRegionControls() {
  var normalProvince = document.getElementById("ship-province");
  var normalCity = document.getElementById("ship-city");
  var genProvince = document.getElementById("ship-gen-province");
  var genCity = document.getElementById("ship-gen-city");

  if (normalProvince && !normalProvince.dataset.regionBound) {
    normalProvince.dataset.regionBound = "1";
    normalProvince.addEventListener("change", function () {
      populateCitySelect("ship-province", "ship-city", "");
      populateDistrictSelect("ship-province", "ship-city", "ship-district", "");
      applyShippingEstimate("ship-province", "ship-city", "ship-cost", "ship-estimated-days", "ship-cost-hint", true);
    });
  }
  if (normalCity && !normalCity.dataset.regionBound) {
    normalCity.dataset.regionBound = "1";
    normalCity.addEventListener("change", function () {
      populateDistrictSelect("ship-province", "ship-city", "ship-district", "");
      applyShippingEstimate("ship-province", "ship-city", "ship-cost", "ship-estimated-days", "ship-cost-hint", true);
    });
  }
  if (genProvince && !genProvince.dataset.regionBound) {
    genProvince.dataset.regionBound = "1";
    genProvince.addEventListener("change", function () {
      populateCitySelect("ship-gen-province", "ship-gen-city", "");
      fillGenerateDistricts();
      applyShippingEstimate("ship-gen-province", "ship-gen-city", "ship-gen-cost", "ship-gen-estimated-days", "ship-gen-cost-hint", true);
    });
  }
  if (genCity && !genCity.dataset.regionBound) {
    genCity.dataset.regionBound = "1";
    genCity.addEventListener("change", function () {
      fillGenerateDistricts();
      applyShippingEstimate("ship-gen-province", "ship-gen-city", "ship-gen-cost", "ship-gen-estimated-days", "ship-gen-cost-hint", true);
    });
  }
  markManualShippingInput("ship-cost");
  markManualShippingInput("ship-gen-cost");
}

function shippingPayload() {
  return {
    province: document.getElementById("ship-province").value.trim(),
    city: document.getElementById("ship-city").value.trim(),
    district: document.getElementById("ship-district").value.trim(),
    courier: document.getElementById("ship-courier").value.trim() || "JNE",
    service: document.getElementById("ship-service").value.trim() || "REG",
    shipping_cost: document.getElementById("ship-cost").value.trim(),
    estimated_days: document.getElementById("ship-estimated-days").value.trim(),
    notes: document.getElementById("ship-notes").value.trim()
  };
}

async function loadShippingRates() {
  var list = document.getElementById("shipping-list");
  var empty = document.getElementById("shipping-empty");
  var count = document.getElementById("shipping-count");
  if (!list) return;

  list.innerHTML = '<div class="cs-template-state">Memuat data...</div>';
  try {
    var data = await api.get("/api/shipping-rates");

    if (count) count.textContent = data.length;
    if (empty) empty.style.display = data.length ? "none" : "block";
    list.innerHTML = "";

    data.forEach(function (item) {
      var div = document.createElement("article");
      div.className = "kb-card";
      div._shippingRate = item;
      var location = [item.district, item.city, item.province].filter(Boolean).join(", ");
      div.innerHTML =
        '<div class="kb-card-head">' +
          '<div style="min-width:0">' +
            '<div class="product-name">' + escHtml(location || "-") + '</div>' +
            '<div class="product-price">' + escHtml(item.shipping_cost_label || "") + '</div>' +
          '</div>' +
          '<div class="product-actions">' +
            '<button class="btn btn-ghost btn-xs" type="button" onclick="editShippingRate(this)" title="Edit ongkir" aria-label="Edit ongkir">&#x270F;</button>' +
            '<button class="btn btn-danger btn-xs" type="button" onclick="deleteShippingRate(this)" title="Hapus ongkir" aria-label="Hapus ongkir">&#x1F5D1;</button>' +
          '</div>' +
        '</div>' +
        '<div class="kb-card-body">' +
          '<div class="kb-meta-grid">' +
            '<div class="kb-meta"><div class="kb-meta-label">Kurir</div><div class="kb-meta-value">' + escHtml((item.courier || "-") + " " + (item.service || "")) + '</div></div>' +
            '<div class="kb-meta"><div class="kb-meta-label">Estimasi</div><div class="kb-meta-value">' + escHtml(item.estimated_days || "-") + '</div></div>' +
            '<div class="kb-meta"><div class="kb-meta-label">Catatan</div><div class="kb-meta-value">' + escHtml(item.notes || "-") + '</div></div>' +
          '</div>' +
        '</div>';
      list.appendChild(div);
    });
  } catch (err) {
    list.innerHTML = '<div class="cs-template-state cs-template-state-error">' + escHtml(err.message || "Gagal memuat ongkir") + '</div>';
    if (count) count.textContent = "0";
  }
}

async function openShippingModal() {
  await loadShippingRegions();
  bindShippingRegionControls();
  document.getElementById("modal-shipping-title").innerHTML = "&#x2795; Tambah Ongkir";
  document.getElementById("ship-id").value = "";
  populateProvinceSelect("ship-province", "");
  populateCitySelect("ship-province", "ship-city", "");
  populateDistrictSelect("ship-province", "ship-city", "ship-district", "");
  document.getElementById("ship-cost").value = "";
  document.getElementById("ship-cost").dataset.autoEstimate = "1";
  document.getElementById("ship-courier").value = "JNE";
  document.getElementById("ship-service").value = "REG";
  document.getElementById("ship-estimated-days").value = "";
  document.getElementById("ship-estimated-days").dataset.autoEstimate = "1";
  document.getElementById("ship-notes").value = "";
  applyShippingEstimate("ship-province", "ship-city", "ship-cost", "ship-estimated-days", "ship-cost-hint", false);
  openModal("modal-shipping");
}

async function openShippingGenerateModal() {
  await loadShippingRegions();
  bindShippingRegionControls();
  populateProvinceSelect("ship-gen-province", "");
  populateCitySelect("ship-gen-province", "ship-gen-city", "");
  document.getElementById("ship-gen-cost").value = "";
  document.getElementById("ship-gen-cost").dataset.autoEstimate = "1";
  document.getElementById("ship-gen-courier").value = "JNE";
  document.getElementById("ship-gen-service").value = "REG";
  document.getElementById("ship-gen-estimated-days").value = "";
  document.getElementById("ship-gen-estimated-days").dataset.autoEstimate = "1";
  document.getElementById("ship-gen-districts").value = "";
  document.getElementById("ship-gen-notes").value = "";
  document.getElementById("ship-gen-overwrite").checked = false;
  applyShippingEstimate("ship-gen-province", "ship-gen-city", "ship-gen-cost", "ship-gen-estimated-days", "ship-gen-cost-hint", false);
  openModal("modal-shipping-generate");
}

function shippingGeneratePayload() {
  return {
    province: document.getElementById("ship-gen-province").value.trim(),
    city: document.getElementById("ship-gen-city").value.trim(),
    shipping_cost: document.getElementById("ship-gen-cost").value.trim(),
    courier: document.getElementById("ship-gen-courier").value.trim() || "JNE",
    service: document.getElementById("ship-gen-service").value.trim() || "REG",
    estimated_days: document.getElementById("ship-gen-estimated-days").value.trim(),
    districts: document.getElementById("ship-gen-districts").value.trim(),
    notes: document.getElementById("ship-gen-notes").value.trim(),
    overwrite: document.getElementById("ship-gen-overwrite").checked
  };
}

async function generateShippingRates() {
  var data = shippingGeneratePayload();
  if (!data.city) {
    toast("Kab/Kota wajib diisi", "error");
    return;
  }
  if (!data.shipping_cost) {
    toast("Ongkir wajib diisi", "error");
    return;
  }
  if (!data.districts) {
    toast("Daftar kecamatan wajib diisi", "error");
    return;
  }

  try {
    var result = await api.post("/api/shipping-rates/bulk-generate", data);
    if (result.success === false) throw new Error(result.error || "Gagal generate ongkir");
    closeModal("modal-shipping-generate");
    await loadShippingRates();
    toast("Generate selesai: " + result.created_count + " baru, " + result.updated_count + " update, " + result.skipped_count + " skip");
  } catch (err) {
    toast(err.message || "Gagal generate ongkir", "error");
  }
}

async function editShippingRate(button) {
  var item = button.closest(".kb-card")._shippingRate;
  await loadShippingRegions();
  bindShippingRegionControls();
  document.getElementById("modal-shipping-title").textContent = "Edit Ongkir";
  document.getElementById("ship-id").value = item.id || "";
  populateProvinceSelect("ship-province", item.province || "");
  populateCitySelect("ship-province", "ship-city", item.city || "");
  populateDistrictSelect("ship-province", "ship-city", "ship-district", item.district || "");
  document.getElementById("ship-cost").value = item.shipping_cost || "";
  document.getElementById("ship-cost").dataset.autoEstimate = "0";
  document.getElementById("ship-courier").value = item.courier || "JNE";
  document.getElementById("ship-service").value = item.service || "REG";
  document.getElementById("ship-estimated-days").value = item.estimated_days || "";
  document.getElementById("ship-estimated-days").dataset.autoEstimate = "0";
  document.getElementById("ship-notes").value = item.notes || "";
  applyShippingEstimate("ship-province", "ship-city", "ship-cost", "ship-estimated-days", "ship-cost-hint", false);
  openModal("modal-shipping");
}

async function saveShippingRate() {
  var id = document.getElementById("ship-id").value;
  var data = shippingPayload();
  if (!data.city) {
    toast("Kab/Kota wajib diisi", "error");
    return;
  }
  if (!data.shipping_cost) {
    toast("Ongkir wajib diisi", "error");
    return;
  }

  try {
    var result = id
      ? await api.put("/api/shipping-rates/" + id, data)
      : await api.post("/api/shipping-rates", data);
    if (result.success === false) throw new Error(result.error || "Gagal menyimpan ongkir");
    closeModal("modal-shipping");
    await loadShippingRates();
    toast("Ongkir disimpan");
  } catch (err) {
    toast(err.message || "Gagal menyimpan ongkir", "error");
  }
}

async function deleteShippingRate(button) {
  var item = button.closest(".kb-card")._shippingRate;
  if (!confirm("Hapus ongkir ini?")) return;
  try {
    var result = await api.delete("/api/shipping-rates/" + item.id);
    if (result.success === false) throw new Error(result.error || "Gagal menghapus ongkir");
    await loadShippingRates();
    toast("Ongkir dihapus");
  } catch (err) {
    toast(err.message || "Gagal menghapus ongkir", "error");
  }
}

async function syncRajaOngkirRate() {
  var data = shippingPayload();
  if (!data.city) {
    toast("Kab/Kota wajib diisi", "error");
    return;
  }
  data.weight = 500;
  data.overwrite = true;
  try {
    var result = await api.post("/api/shipping-rates/rajaongkir-sync", data);
    if (result.success === false) throw new Error(result.error || "Gagal sync RajaOngkir");
    var rate = result.rate || {};
    document.getElementById("ship-cost").value = rate.shipping_cost || "";
    document.getElementById("ship-estimated-days").value = rate.estimated_days || "";
    document.getElementById("ship-courier").value = rate.courier || data.courier || "JNE";
    document.getElementById("ship-service").value = rate.service || data.service || "REG";
    await loadShippingRates();
    toast("Ongkir tersinkron dari RajaOngkir");
  } catch (err) {
    toast(err.message || "Gagal sync RajaOngkir", "error");
  }
}
