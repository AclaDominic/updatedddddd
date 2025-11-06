import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "../Header";
import Pusher from "pusher-js";
import AlkansyaDailyOutputModal from "./AlkansyaDailyOutputModal";

/**
 * Enhanced Inventory Management Page with Material CRUD Operations
 * Features:
 * - Add new materials (raw/finished goods)
 * - Edit existing materials
 * - Delete materials
 * - Real-time tracking and analytics
 * - Automated reports and forecasting
 * - Grouped display: Raw Materials first, then Finished Products
 * - Modern, engaging dashboard design
 */

// Custom styles for simple, clean design
const customStyles = `
  .table tbody tr {
    transition: background-color 0.2s ease;
  }
  .table tbody tr:hover {
    background-color: #f8f9fa;
  }
`;

const DEFAULTS = {
  forecastWindowDays: 14,
  planningHorizonDays: 30,
  pollIntervalMs: 15000,
};

// Utility functions
function toCSV(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) =>
    v === null || v === undefined
      ? ""
      : String(v)
          .replaceAll("\"", '""')
          .replace(/[\n\r]/g, " ");
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => `"${escape(r[h])}"`).join(","));
  }
  return lines.join("\n");
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x);
    (acc[k] = acc[k] || []).push(x);
    return acc;
  }, {});
}

function parseUsageCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift();
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const skuIdx = cols.indexOf("sku");
  const dateIdx = cols.indexOf("date");
  const qtyIdx = cols.indexOf("qtyused");
  if (skuIdx === -1 || dateIdx === -1 || qtyIdx === -1) {
    throw new Error("CSV must have headers: sku,date,qtyUsed");
  }
  return lines.map((ln) => {
    const parts = ln.split(",");
    return {
      sku: parts[skuIdx]?.trim(),
      date: parts[dateIdx]?.trim(),
      qtyUsed: Number(parts[qtyIdx]?.trim() || 0),
    };
  });
}

function movingAverageDaily(usageByDayArr, windowDays) {
  if (!usageByDayArr || usageByDayArr.length === 0) return 0;
  const lastN = usageByDayArr
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-windowDays);
  const total = lastN.reduce((s, r) => s + Number(r.qtyUsed || 0), 0);
  return total / Math.max(1, lastN.length);
}

function daysUntil(quantity, dailyUsage) {
  if (dailyUsage <= 0) return Infinity;
  return quantity / dailyUsage;
}

function projectOnHand(onHand, dailyUsage, days) {
  const arr = [];
  let bal = onHand;
  for (let d = 0; d <= days; d++) {
    arr.push({ day: d, projected: Math.max(0, Math.round(bal)) });
    bal -= dailyUsage;
  }
  return arr;
}

function statusFromLevels({ onHand, rop, maxLevel }) {
  if (onHand <= rop) return { label: "Reorder now", variant: "danger" };
  if (maxLevel && onHand > maxLevel) return { label: "Overstock", variant: "warning" };
  return { label: "OK", variant: "success" };
}

// Material Form Modal Component
const MaterialModal = ({ show, onHide, material, onSave }) => {
  const [formData, setFormData] = useState({
    name: "",
    sku: "",
    category: "raw",
    location: "",
    quantity: 0,
    unit: "",
    cost: 0,
    supplier: "",
    lead_time_days: 0,
    safety_stock: 0,
    max_level: 0,
    reorder_point: 0,
    description: ""
  });

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (material) {
      setFormData({
        name: material.name || "",
        sku: material.sku || "",
        category: material.category || "raw",
        location: material.location || "",
        quantity: (material.quantity_on_hand ?? material.quantity ?? 0),
        unit: material.unit || "",
        cost: (material.unit_cost ?? material.cost ?? 0),
        supplier: material.supplier || "",
        lead_time_days: material.lead_time_days || material.leadTimeDays || 0,
        safety_stock: material.safety_stock || material.safetyStock || 0,
        max_level: material.max_level || material.maxLevel || 0,
        reorder_point: material.reorder_point || material.reorderPoint || 0,
        description: material.description || ""
      });
    } else {
      setFormData({
        name: "",
        sku: "",
        category: "raw",
        location: "",
        quantity: 0,
        unit: "",
        cost: 0,
        supplier: "",
        lead_time_days: 0,
        safety_stock: 0,
        max_level: 0,
        reorder_point: 0,
        description: ""
      });
    }
    setErrors({});
  }, [material, show]);

  const validateForm = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = "Name is required";
    if (!formData.sku.trim()) newErrors.sku = "SKU is required";
    if (!formData.location.trim()) newErrors.location = "Location is required";
    if (formData.quantity < 0) newErrors.quantity = "Quantity cannot be negative";
    if (formData.cost < 0) newErrors.cost = "Cost cannot be negative";
    if (formData.lead_time_days < 0) newErrors.lead_time_days = "Lead time cannot be negative";
    if (formData.safety_stock < 0) newErrors.safety_stock = "Safety stock cannot be negative";
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    // Sanitize category to match backend enum
    const allowedCategories = ["raw", "finished"];
    const sanitizedCategory = allowedCategories.includes(formData.category)
      ? formData.category
      : "raw";

    setSaving(true);
    try {
      await onSave({ ...formData, category: sanitizedCategory });
      onHide();
    } catch (error) {
      console.error("Save failed:", error);
      alert("Failed to save material. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  if (!show) return null;

  return (
    <div className="modal show d-block" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
      <div className="modal-dialog modal-lg">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">
              {material ? "Edit Material" : "Add New Material"}
            </h5>
            <button type="button" className="btn-close" onClick={onHide}></button>
          </div>
          <div className="modal-body">
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Name *</label>
                <input
                  type="text"
                  className={`form-control ${errors.name ? "is-invalid" : ""}`}
                  value={formData.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                />
                {errors.name && <div className="invalid-feedback">{errors.name}</div>}
              </div>
              <div className="col-md-6">
                <label className="form-label">SKU *</label>
                <input
                  type="text"
                  className={`form-control ${errors.sku ? "is-invalid" : ""}`}
                  value={formData.sku}
                  onChange={(e) => handleChange("sku", e.target.value)}
                />
                {errors.sku && <div className="invalid-feedback">{errors.sku}</div>}
              </div>
              <div className="col-md-6">
                <label className="form-label">Category</label>
                <select
                  className="form-select"
                  value={formData.category}
                  onChange={(e) => handleChange("category", e.target.value)}
                >
                  <option value="raw">Raw Material</option>
                  <option value="finished">Finished Good</option>
                </select>
              </div>
              <div className="col-md-6">
                <label className="form-label">Location *</label>
                <input
                  type="text"
                  className={`form-control ${errors.location ? "is-invalid" : ""}`}
                  value={formData.location}
                  onChange={(e) => handleChange("location", e.target.value)}
                  placeholder="e.g., Warehouse A, Shelf B2"
                />
                {errors.location && <div className="invalid-feedback">{errors.location}</div>}
              </div>
              <div className="col-md-4">
                <label className="form-label">Quantity</label>
                <input
                  type="number"
                  className={`form-control ${errors.quantity ? "is-invalid" : ""}`}
                  value={formData.quantity}
                  onChange={(e) => handleChange("quantity", Math.max(0, parseInt(e.target.value || 0, 10)))}
                  min="0"
                  step="1"
                />
                {errors.quantity && <div className="invalid-feedback">{errors.quantity}</div>}
              </div>
              <div className="col-md-4">
                <label className="form-label">Unit</label>
                <input
                  type="text"
                  className="form-control"
                  value={formData.unit}
                  onChange={(e) => handleChange("unit", e.target.value)}
                  placeholder="kg, pcs, m, etc."
                />
              </div>
              <div className="col-md-4">
                <label className="form-label">Unit Cost</label>
                <input
                  type="number"
                  className={`form-control ${errors.cost ? "is-invalid" : ""}`}
                  value={formData.cost}
                  onChange={(e) => handleChange("cost", Number(e.target.value))}
                  min="0"
                  step="0.01"
                />
                {errors.cost && <div className="invalid-feedback">{errors.cost}</div>}
              </div>
              <div className="col-md-6">
                <label className="form-label">Supplier</label>
                <input
                  type="text"
                  className="form-control"
                  value={formData.supplier}
                  onChange={(e) => handleChange("supplier", e.target.value)}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label">Lead Time (days)</label>
                <input
                  type="number"
                  className={`form-control ${errors.lead_time_days ? "is-invalid" : ""}`}
                  value={formData.lead_time_days}
                  onChange={(e) => handleChange("lead_time_days", Math.max(0, parseInt(e.target.value || 0, 10)))}
                  min="0"
                  step="1"
                />
                {errors.lead_time_days && <div className="invalid-feedback">{errors.lead_time_days}</div>}
              </div>
              <div className="col-md-4">
                <label className="form-label">Safety Stock</label>
                <input
                  type="number"
                  className={`form-control ${errors.safety_stock ? "is-invalid" : ""}`}
                  value={formData.safety_stock}
                  onChange={(e) => handleChange("safety_stock", Math.max(0, parseInt(e.target.value || 0, 10)))}
                  min="0"
                  step="1"
                />
                {errors.safety_stock && <div className="invalid-feedback">{errors.safety_stock}</div>}
              </div>
              <div className="col-md-4">
                <label className="form-label">Max Level</label>
                <input
                  type="number"
                  className="form-control"
                  value={formData.max_level}
                  onChange={(e) => handleChange("max_level", Math.max(0, parseInt(e.target.value || 0, 10)))}
                  min="0"
                  step="1"
                />
              </div>
              <div className="col-md-4">
                <label className="form-label">Reorder Point</label>
                <input
                  type="number"
                  className="form-control"
                  value={formData.reorder_point}
                  onChange={(e) => handleChange("reorder_point", Math.max(0, parseInt(e.target.value || 0, 10)))}
                  min="0"
                  step="1"
                />
              </div>
              <div className="col-12">
                <label className="form-label">Description</label>
                <textarea
                  className="form-control"
                  rows="3"
                  value={formData.description}
                  onChange={(e) => handleChange("description", e.target.value)}
                  placeholder="Additional notes about this material..."
                />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onHide}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : (material ? "Update" : "Add")} Material
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Main Inventory Component
const InventoryPage = () => {
  const navigate = useNavigate();
  const [inventory, setInventory] = useState([]);
  const [usage, setUsage] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState({ q: "", type: "all", product: "all" });
  const [showModal, setShowModal] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState(null);
  const [showAlkansyaModal, setShowAlkansyaModal] = useState(false);
  const wsRef = useRef(null);
  const pollRef = useRef(null);
  const fileInputRef = useRef(null);

  // API helper function
  const apiBase = process.env.REACT_APP_API_BASE_URL || "http://localhost:8000/api";
  const apiCall = async (path, options = {}) => {
    const token = localStorage.getItem("token");
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    };

    const url = path.startsWith('http') ? path : `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  };

  // Fetch inventory and usage data
  useEffect(() => {
    fetchInventory();
  }, []);

  const fetchInventory = async () => {
    setLoading(true);
    setError("");
    try {
      const [invRes, usageRes] = await Promise.allSettled([
        apiCall("/inventory"),
        apiCall("/usage?days=120"),
      ]);

      if (invRes.status === "fulfilled") setInventory(invRes.value || []);
      else throw invRes.reason;

      if (usageRes.status === "fulfilled") setUsage(usageRes.value || []);
    } catch (err) {
      console.error(err);
      setError("Failed to fetch initial data. Check API settings.");
    } finally {
      setLoading(false);
    }
  };

  // Material CRUD operations
  const handleAddMaterial = () => {
    setEditingMaterial(null);
    setShowModal(true);
  };

  const handleEditMaterial = (material) => {
    setEditingMaterial(material);
    setShowModal(true);
  };

  const handleSaveMaterial = async (materialData) => {
    try {
      const payload = {
        name: materialData.name,
        sku: materialData.sku,
        category: materialData.category,
        location: materialData.location,
        unit: materialData.unit,
        unit_cost: Number(materialData.cost || 0),
        supplier: materialData.supplier,
        description: materialData.description,
        quantity_on_hand: Number(materialData.quantity || 0),
        lead_time_days: Number(materialData.lead_time_days || 0),
        safety_stock: Number(materialData.safety_stock || 0),
        max_level: Number(materialData.max_level || 0),
        reorder_point: Number(materialData.reorder_point || 0),
      };
      if (editingMaterial) {
        // Update existing material
        const response = await apiCall(
          `/inventory/${editingMaterial.id}`,
          {
            method: 'PUT',
            body: JSON.stringify(payload)
          }
        );
        setInventory(prev => 
          prev.map(item => 
            item.id === editingMaterial.id ? response : item
          )
        );
      } else {
        // Add new material
        const response = await apiCall(
          "/inventory",
          {
            method: 'POST',
            body: JSON.stringify(payload)
          }
        );
        setInventory(prev => [...prev, response]);
      }
    } catch (error) {
      console.error("Save material error:", error);
      throw error;
    }
  };

  const handleDeleteMaterial = async (materialId) => {
    if (!window.confirm("Are you sure you want to delete this material? This action cannot be undone.")) {
      return;
    }

    try {
      await apiCall(`/inventory/${materialId}`, {
        method: 'DELETE'
      });
      setInventory(prev => prev.filter(item => item.id !== materialId));
    } catch (error) {
      console.error("Delete material error:", error);
      alert("Failed to delete material. Please try again.");
    }
  };

  // Real-time tracking via Pusher with polling fallback
  useEffect(() => {
    const key = process.env.REACT_APP_PUSHER_KEY || "";
    const cluster = process.env.REACT_APP_PUSHER_CLUSTER || "mt1";
    if (key) {
      const p = new Pusher(key, { cluster });
      const ch = p.subscribe("inventory-channel");
      const handler = (data) => {
        const item = data.item || data;
        setInventory((prev) => prev.map((it) => (it.id === item.id ? { ...it, ...item } : it)));
      };
      ch.bind("inventory-updated", handler);
      wsRef.current = p;
      return () => {
        ch.unbind("inventory-updated", handler);
        p.unsubscribe("inventory-channel");
        p.disconnect();
      };
    } else {
      startPolling();
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      };
    }

    function startPolling() {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const data = await apiCall("/inventory");
          setInventory(data || []);
        } catch (e) {
          console.warn("Polling failed", e);
        }
      }, DEFAULTS.pollIntervalMs);
    }
  }, []);

  // Derived analytics per item
  const enriched = useMemo(() => {
    const usageBySku = groupBy(usage || [], (u) => u.sku);

    const safeEtaFromDays = (days) => {
      if (!Number.isFinite(days) || days < 0) return "-";
      const millis = Date.now() + Math.floor(days) * 86400000;
      const d = new Date(millis);
      return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "-";
    };

    const rows = (inventory || []).map((it) => {
      const onHand = Number(it.quantity ?? it.quantity_on_hand ?? 0);
      const lead = Number(it.lead_time_days ?? it.leadTimeDays ?? 0);
      const safety = Number(it.safety_stock ?? it.safetyStock ?? 0);
      const maxLevel = Number(it.max_level ?? it.maxLevel ?? 0) || undefined;
      const category = it.category || it.type || "unspecified";

      const history = (usageBySku[it.sku] || [])
        .map((u) => ({ date: u.date, qtyUsed: Number(u.qtyUsed || 0) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const avgDaily = Number(
        it.avg_daily_usage ?? it.avgDailyUsage ?? movingAverageDaily(history, DEFAULTS.forecastWindowDays)
      );

      const ropBackend = it.reorder_point ?? it.reorderPoint;
      const ropCalc = Math.round(avgDaily * lead + safety);
      const rop = Number(ropBackend ?? ropCalc);

      const daysCover = daysUntil(onHand, avgDaily);
      const projected = projectOnHand(onHand, avgDaily, DEFAULTS.planningHorizonDays);

      const status = statusFromLevels({ onHand, rop, maxLevel });

      const target = maxLevel || rop + safety;
      const suggestedOrderQty = onHand <= rop ? Math.max(0, Math.round(target - onHand)) : 0;

      const rawDaysToROP = (onHand - rop) / (avgDaily > 0 ? avgDaily : Infinity);
      const daysToROP = Number.isFinite(rawDaysToROP) ? Math.max(0, Math.ceil(rawDaysToROP)) : null;
      const etaReorderDate = safeEtaFromDays(daysToROP ?? NaN);

      return {
        ...it,
        category,
        onHand,
        avgDaily: Number(avgDaily.toFixed(2)),
        leadTimeDays: lead,
        safetyStock: safety,
        rop,
        daysCover: isFinite(daysCover) ? Number(daysCover.toFixed(1)) : "∞",
        projected,
        status,
        suggestedOrderQty,
        etaReorderDate,
        maxLevel,
      };
    });

    return rows.sort((a, b) => {
      const pri = { danger: 0, warning: 1, success: 2 };
      return (pri[a.status.variant] ?? 2) - (pri[b.status.variant] ?? 2);
    });
  }, [inventory, usage]);

  // Filters and grouping with product-specific filtering
  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    const type = filter.type;
    const product = filter.product;
    
    return enriched.filter((it) => {
      const matchesQ = !q || [it.name, it.sku, it.location, it.category, it.description].join(" ").toLowerCase().includes(q);
      const matchesType = type === "all" || 
        (type === "raw" && it.category.toLowerCase().includes("raw")) || 
        (type === "finished" && it.category.toLowerCase().includes("finished"));
      
      // Product-specific filtering
      let matchesProduct = true;
      if (product !== "all") {
        const itemText = [it.name, it.description, it.sku].join(" ").toLowerCase();
        if (product === "alkansya") {
          matchesProduct = itemText.includes("alkansya");
        } else if (product === "table") {
          matchesProduct = itemText.includes("table") || itemText.includes("dining");
        } else if (product === "chair") {
          matchesProduct = itemText.includes("chair");
        }
      }
      
      return matchesQ && matchesType && matchesProduct;
    });
  }, [enriched, filter]);

  // Group materials by category - Raw Materials first, then Finished Products
  const groupedInventory = useMemo(() => {
    const raw = filtered.filter(item => item.category.toLowerCase().includes("raw"));
    const finished = filtered.filter(item => item.category.toLowerCase().includes("finished"));
    return { raw, finished };
  }, [filtered]);

  // Export functions
  const exportStockReport = () => {
    const rows = enriched.map((it) => ({
      SKU: it.sku,
      Item: it.name,
      Category: it.category,
      Location: it.location,
      OnHand: it.onHand,
      AvgDailyUsage: it.avgDaily,
      LeadTimeDays: it.leadTimeDays,
      SafetyStock: it.safetyStock,
      ROP: it.rop,
      DaysCover: it.daysCover,
      Status: it.status.label,
    }));
    download(`stock_levels_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows));
  };

  const exportReplenishmentPlan = () => {
    const rows = enriched
      .filter((it) => it.suggestedOrderQty > 0)
      .map((it) => ({
        SKU: it.sku,
        Item: it.name,
        SuggestedOrderQty: it.suggestedOrderQty,
        ROP: it.rop,
        OnHand: it.onHand,
        LeadTimeDays: it.leadTimeDays,
        ETAReorderDate: it.etaReorderDate,
      }));
    download(`replenishment_plan_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows));
  };

  const exportUsageTrends = () => {
    const rows = (usage || []).map((u) => ({ SKU: u.sku, Date: u.date, QtyUsed: u.qtyUsed }));
    download(`usage_trends_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows));
  };

  // CSV usage upload
  const onUploadUsage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const rows = parseUsageCSV(text);
      setUsage((prev) => [...prev, ...rows]);
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <AppLayout>
    <style>{customStyles}</style>
    <div className="container-fluid py-4" role="region" aria-labelledby="inv-heading">
      {/* Navigation Buttons */}
      <div className="d-flex gap-2 mb-3">
        <button className="btn btn-outline-secondary" onClick={() => navigate("/dashboard")}>
          ← Back to Dashboard
        </button>
        
      </div>


    <div className="container-fluid py-4">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h2 id="inv-heading" className="mb-0">Inventory Management</h2>
        <div className="d-flex gap-2 flex-wrap">
          <button className="btn btn-info" onClick={() => setShowAlkansyaModal(true)}>
            <i className="fas fa-piggy-bank me-2"></i>
            + Finished Alkansya for Daily Output
          </button>
          <button className="btn btn-success" onClick={handleAddMaterial}>
            + Add Material
          </button>
          <button className="btn btn-outline-secondary" onClick={exportStockReport}>
            Export Stock CSV
          </button>
          <button className="btn btn-outline-primary" onClick={exportReplenishmentPlan}>
            Export Replenishment CSV
            Export Usage CSV
          </button>
          <label className="btn btn-outline-success mb-0">
            Upload Usage CSV
            <input ref={fileInputRef} type="file" accept=".csv" onChange={onUploadUsage} hidden />
          </label>
        </div>
      </div>

      {/* Search and Filter */}
      <div className="card mb-4 shadow-sm">
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label small text-muted mb-1">Search</label>
              <input
                className="form-control"
                placeholder="Search by name, SKU, location..."
                value={filter.q}
                onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
              />
            </div>
            <div className="col-md-3">
              <label className="form-label small text-muted mb-1">Category</label>
              <select
                className="form-select"
                value={filter.type}
                onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value }))}
              >
                <option value="all">All Categories</option>
                <option value="raw">Raw Materials</option>
                <option value="finished">Finished Products</option>
              </select>
            </div>
            <div className="col-md-3">
              <label className="form-label small text-muted mb-1">Product Filter</label>
              <select
                className="form-select"
                value={filter.product}
                onChange={(e) => setFilter((f) => ({ ...f, product: e.target.value }))}
              >
                <option value="all">All Products</option>
                <option value="alkansya">Alkansya</option>
                <option value="table">Dining Table</option>
                <option value="chair">Chair</option>
              </select>
            </div>
            <div className="col-md-2 d-flex align-items-end">
              <button 
                className="btn btn-outline-secondary w-100"
                onClick={() => setFilter({ q: "", type: "all", product: "all" })}
              >
                Clear Filters
              </button>
            </div>
          </div>
        </div>
      </div>

      {loading && (
        <div className="alert alert-info">Loading inventory…</div>
      )}
      {error && (
        <div className="alert alert-danger">{error}</div>
      )}

      {/* KPI Summary - Simplified */}
      {!loading && (
        <div className="row g-3 mb-4">
          <div className="col-md-3">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <div className="text-muted small mb-1">Total Items</div>
                <div className="h3 mb-1 text-primary fw-bold">{enriched.length}</div>
                <div className="small text-muted">
                  {groupedInventory.raw.length} materials • {groupedInventory.finished.length} products
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <div className="text-muted small mb-1">Reorder Alerts</div>
                <div className="h3 mb-1 text-danger fw-bold">{enriched.filter((x) => x.status.variant === "danger").length}</div>
                <div className="small text-muted">
                  {enriched.filter((x) => x.status.variant === "danger").length > 0 ? "Action required" : "All stocked"}
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <div className="text-muted small mb-1">Low Stock</div>
                <div className="h3 mb-1 text-warning fw-bold">
                  {enriched.filter((x) => typeof x.daysCover === 'number' && x.daysCover < 14).length}
                </div>
                <div className="small text-muted">Less than 14 days</div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm h-100">
              <div className="card-body">
                <div className="text-muted small mb-1">Showing</div>
                <div className="h3 mb-1 text-success fw-bold">{filtered.length}</div>
                <div className="small text-muted">Filtered items</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RAW MATERIALS SECTION */}
      {(filter.type === "all" || filter.type === "raw") && groupedInventory.raw.length > 0 && (
        <div className="mb-4">
          <div className="d-flex align-items-center justify-content-between mb-2">
            <h5 className="mb-0">📦 Raw Materials</h5>
            <span className="badge bg-primary">{groupedInventory.raw.length} items</span>
          </div>
          
          <div className="card shadow-sm">
            <div className="table-responsive">
              <table className="table table-hover mb-0">
                <thead className="table-light">
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Location</th>
                    <th className="text-end">Stock</th>
                    <th className="text-end">Daily Use</th>
                    <th>Status</th>
                    <th className="text-end">Reorder Qty</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedInventory.raw.map((item) => (
                    <tr key={item.id || item.sku}>
                      <td><code className="small">{item.sku}</code></td>
                      <td>
                        <div>{item.name}</div>
                        {item.description && <small className="text-muted">{item.description.substring(0, 40)}...</small>}
                      </td>
                      <td><small>{item.location}</small></td>
                      <td className="text-end">
                        <strong>{item.onHand}</strong> <small className="text-muted">{item.unit}</small>
                      </td>
                      <td className="text-end">{item.avgDaily}</td>
                      <td>
                        <span className={`badge bg-${item.status.variant}`}>
                          {item.status.label}
                        </span>
                      </td>
                      <td className="text-end">
                        {item.suggestedOrderQty > 0 ? (
                          <strong className="text-danger">{item.suggestedOrderQty}</strong>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td>
                        <button 
                          className="btn btn-sm btn-outline-primary me-1"
                          onClick={() => handleEditMaterial(item)}
                        >
                          Edit
                        </button>
                        <button 
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleDeleteMaterial(item.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* FINISHED PRODUCTS SECTION */}
      {(filter.type === "all" || filter.type === "finished") && groupedInventory.finished.length > 0 && (
        <div className="mb-4">
          <div className="d-flex align-items-center justify-content-between mb-2">
            <h5 className="mb-0">✅ Finished Products</h5>
            <span className="badge bg-success">{groupedInventory.finished.length} items</span>
          </div>
          
          <div className="card shadow-sm">
            <div className="table-responsive">
              <table className="table table-hover mb-0">
                <thead className="table-light">
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Location</th>
                    <th className="text-end">Stock</th>
                    <th className="text-end">Daily Sales</th>
                    <th>Status</th>
                    <th className="text-end">Production Needed</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedInventory.finished.map((item) => (
                    <tr key={item.id || item.sku}>
                      <td><code className="small">{item.sku}</code></td>
                      <td>
                        <div>{item.name}</div>
                        {item.description && <small className="text-muted">{item.description.substring(0, 40)}...</small>}
                      </td>
                      <td><small>{item.location}</small></td>
                      <td className="text-end">
                        <strong>{item.onHand}</strong> <small className="text-muted">{item.unit}</small>
                      </td>
                      <td className="text-end">{item.avgDaily}</td>
                      <td>
                        <span className={`badge bg-${item.status.variant}`}>
                          {item.status.label}
                        </span>
                      </td>
                      <td className="text-end">
                        {item.suggestedOrderQty > 0 ? (
                          <strong className="text-danger">{item.suggestedOrderQty}</strong>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td>
                        <button 
                          className="btn btn-sm btn-outline-primary me-1"
                          onClick={() => handleEditMaterial(item)}
                        >
                          Edit
                        </button>
                        <button 
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleDeleteMaterial(item.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* No Results Message */}
      {filtered.length === 0 && !loading && (
        <div className="alert alert-info text-center">
          <h5>No items found</h5>
          <p className="mb-2">Try adjusting your filters or add new materials</p>
          <button className="btn btn-primary btn-sm" onClick={handleAddMaterial}>
            + Add Material
          </button>
        </div>
      )}

      {/* Material Management Modal */}
      <MaterialModal
        show={showModal}
        onHide={() => setShowModal(false)}
        material={editingMaterial}
        onSave={handleSaveMaterial}
      />

      {/* Alkansya Daily Output Modal */}
      <AlkansyaDailyOutputModal
        show={showAlkansyaModal}
        onHide={() => setShowAlkansyaModal(false)}
        onSuccess={() => fetchInventory()}
      />

      {/* Mini projected stock cards for top 5 critical */}
      <div className="row g-3 mt-3">
        {enriched
          .filter((x) => x.status.variant !== "success")
          .slice(0, 5)
          .map((it) => (
            <div className="col-md-6" key={`proj-${it.sku}`}>
              <div className="card h-100">
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <div>
                      <div className="fw-semibold">{it.name} <span className="text-muted">({it.sku})</span></div>
                      <div className="small text-muted">Projected stock (next {DEFAULTS.planningHorizonDays} days)</div>
                    </div>
                    <span className={`badge text-bg-${it.status.variant}`}>{it.status.label}</span>
                  </div>
                  {/* simple sparkline using inline SVG */}
                  <div style={{ width: "100%", height: 80 }}>
                    <svg viewBox={`0 0 ${DEFAULTS.planningHorizonDays} 100`} preserveAspectRatio="none" width="100%" height="100%">
                      {(() => {
                        const max = Math.max(1, ...it.projected.map((p) => p.projected));
                        const pts = it.projected
                          .map((p) => `${p.day},${100 - Math.round((p.projected / max) * 100)}`)
                          .join(" ");
                        return (
                          <>
                            <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1" />
                            {/* ROP line */}
                            <line x1="0" y1={100 - Math.round((it.rop / max) * 100)} x2={DEFAULTS.planningHorizonDays} y2={100 - Math.round((it.rop / max) * 100)} stroke="red" strokeDasharray="2,2" />
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          ))}
      </div>

      
    </div>
     </div>
    </AppLayout>
  );
};

export default InventoryPage;