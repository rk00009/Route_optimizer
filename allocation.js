"use strict";

const DEFAULT_SAFETY_BUFFER_PERCENTAGE = 10;
const MAX_EXACT_POS = 22;
const GROUP_DISTANCE_KM = 150;

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return number;
}

function coordinate(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function haversineKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const term = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
}

function normalizeInput(input) {
  if (!input || !Array.isArray(input.pos) || !Array.isArray(input.trucks)) {
    throw new Error("Provide PO and truck arrays.");
  }

  const safetyBufferPercentage = input.safetyBufferPercentage === undefined
    ? DEFAULT_SAFETY_BUFFER_PERCENTAGE
    : Number(input.safetyBufferPercentage);
  if (!Number.isFinite(safetyBufferPercentage) || safetyBufferPercentage < 0 || safetyBufferPercentage >= 100) {
    throw new Error("Safety buffer must be a number from 0 to less than 100 percent.");
  }

  const pos = input.pos.map((po, index) => {
    const id = String(po?.id || "").trim();
    const volume = Number(po?.volume);
    if (!id) throw new Error(`PO ${index + 1} is missing an ID.`);
    if (!Number.isFinite(volume) || volume <= 0) throw new Error(`PO ${id} volume must be positive.`);
    const lat = coordinate(po?.lat, `PO ${id} latitude`, -90, 90);
    const lon = coordinate(po?.lon, `PO ${id} longitude`, -180, 180);
    const weight = po?.weight === "" || po?.weight === null || po?.weight === undefined
      ? null
      : finitePositive(po.weight, `PO ${id} weight`);
    return {
      ...po,
      id,
      name: String(po?.name || id),
      region: String(po?.region || "").trim(),
      lat,
      lon,
      volume,
      weight
    };
  });

  const trucks = input.trucks.map((truck, index) => {
    const id = String(truck?.id || "").trim();
    if (!id) throw new Error(`Truck ${index + 1} is missing an ID.`);
    const capacity = finitePositive(truck?.volumeCapacity, `Truck ${id} volume capacity`);
    const payload = truck?.payloadCapacity === "" || truck?.payloadCapacity === null || truck?.payloadCapacity === undefined
      ? null
      : finitePositive(truck.payloadCapacity, `Truck ${id} payload capacity`);
    const truckBuffer = truck?.safetyBufferPercentage === undefined
      ? safetyBufferPercentage
      : Number(truck.safetyBufferPercentage);
    if (!Number.isFinite(truckBuffer) || truckBuffer < 0 || truckBuffer >= 100) {
      throw new Error(`Truck ${id} safety buffer must be from 0 to less than 100 percent.`);
    }
    return {
      ...truck,
      id,
      volumeCapacity: capacity,
      payloadCapacity: payload,
      usableVolume: capacity * (1 - truckBuffer / 100),
      usablePayload: payload === null ? null : payload * (1 - truckBuffer / 100),
      safetyBufferPercentage: truckBuffer,
      available: truck?.available !== false
    };
  });

  if (new Set(pos.map(po => po.id)).size !== pos.length) throw new Error("PO IDs must be unique.");
  if (new Set(trucks.map(truck => truck.id)).size !== trucks.length) throw new Error("Truck IDs must be unique.");
  return { pos, trucks };
}

function groupPOs(pos) {
  const groups = [];
  for (const po of pos) {
    const explicit = po.region.toLowerCase();
    let group = explicit ? groups.find(item => item.key === `region:${explicit}`) : null;
    if (!group && !explicit) {
      group = groups.find(item => item.pos.some(existing => haversineKm(existing, po) <= GROUP_DISTANCE_KM));
    }
    if (!group) {
      group = { key: explicit ? `region:${explicit}` : `corridor:${groups.length + 1}`, label: po.region || "Geographic corridor", pos: [] };
      groups.push(group);
    }
    group.pos.push(po);
  }
  return groups;
}

function subsetBest(items, truck, payloadEnabled) {
  const canTake = po => po.volume <= truck.usableVolume + 1e-9 &&
    (!payloadEnabled || po.weight === null || truck.usablePayload === null);
  const candidates = items.filter(canTake);
  if (!candidates.length) return [];

  if (candidates.length > MAX_EXACT_POS) {
    return candidates.slice().sort((a, b) => b.volume - a.volume)
      .reduce((chosen, po) => {
        const volume = chosen.reduce((sum, item) => sum + item.volume, 0);
        return volume + po.volume <= truck.usableVolume + 1e-9 ? [...chosen, po] : chosen;
      }, []);
  }

  let best = [];
  function search(index, chosen, volume, weight) {
    if (volume > truck.usableVolume + 1e-9) return;
    if (payloadEnabled && truck.usablePayload !== null && weight > truck.usablePayload + 1e-9) return;
    if (volume > best.reduce((sum, po) => sum + po.volume, 0) + 1e-9 ||
      (Math.abs(volume - best.reduce((sum, po) => sum + po.volume, 0)) < 1e-9 && chosen.length < best.length)) {
      best = chosen;
    }
    for (let i = index; i < candidates.length; i++) {
      const po = candidates[i];
      search(i + 1, [...chosen, po], volume + po.volume, weight + (po.weight || 0));
    }
  }
  search(0, [], 0, 0);
  return best;
}

function canFitGroup(group, truck, payloadEnabled) {
  const volume = group.pos.reduce((sum, po) => sum + po.volume, 0);
  const weight = group.pos.reduce((sum, po) => sum + (po.weight || 0), 0);
  const weightsAvailable = group.pos.every(po => po.weight !== null);
  return volume <= truck.usableVolume + 1e-9 &&
    (!payloadEnabled || truck.usablePayload === null || !weightsAvailable || weight <= truck.usablePayload + 1e-9);
}

function allocation(input) {
  const { pos, trucks } = normalizeInput(input);
  const payloadEnabled = input.payloadEnabled === true;
  const available = trucks.filter(truck => truck.available);
  const groups = groupPOs(pos);
  const allocations = [];
  const assigned = new Set();
  const groupResults = [];

  for (const group of groups) {
    const completeOptions = available.filter(truck =>
      !allocations.some(item => item.truck.id === truck.id) &&
      canFitGroup(group, truck, payloadEnabled)
    );
    if (completeOptions.length) {
      const truck = completeOptions.sort((a, b) => a.usableVolume - b.usableVolume)[0];
      allocations.push({ truck, group, pos: group.pos.slice(), completeGroup: true });
      group.pos.forEach(po => assigned.add(po.id));
      groupResults.push({ key: group.key, label: group.label, poIds: group.pos.map(po => po.id), complete: true });
      continue;
    }

    let remaining = group.pos.slice();
    const groupAllocations = [];
    while (remaining.length) {
      const options = available
        .filter(truck => !allocations.some(item => item.truck.id === truck.id))
        .map(truck => ({ truck, pos: subsetBest(remaining, truck, payloadEnabled) }))
        .filter(option => option.pos.length);
      if (!options.length) break;
      options.sort((a, b) => {
        const aVolume = a.pos.reduce((sum, po) => sum + po.volume, 0);
        const bVolume = b.pos.reduce((sum, po) => sum + po.volume, 0);
        return bVolume - aVolume || a.truck.usableVolume - b.truck.usableVolume;
      });
      const chosen = options[0];
      allocations.push({ truck: chosen.truck, group, pos: chosen.pos, completeGroup: false });
      groupAllocations.push(chosen.pos.map(po => po.id));
      chosen.pos.forEach(po => assigned.add(po.id));
      const chosenIds = new Set(chosen.pos.map(po => po.id));
      remaining = remaining.filter(po => !chosenIds.has(po.id));
    }
    groupResults.push({ key: group.key, label: group.label, poIds: group.pos.map(po => po.id), complete: false, allocations: groupAllocations });
  }

  const resultAllocations = allocations.map(item => {
    const assignedVolume = item.pos.reduce((sum, po) => sum + po.volume, 0);
    const assignedWeight = item.pos.every(po => po.weight !== null)
      ? item.pos.reduce((sum, po) => sum + po.weight, 0)
      : null;
    return {
      truck: {
        id: item.truck.id,
        type: item.truck.type || "",
        volumeCapacity: item.truck.volumeCapacity,
        usableVolume: item.truck.usableVolume,
        payloadCapacity: item.truck.payloadCapacity,
        usablePayload: item.truck.usablePayload,
        safetyBufferPercentage: item.truck.safetyBufferPercentage
      },
      groupKey: item.group.key,
      groupLabel: item.group.label,
      pos: item.pos,
      assignedVolume,
      assignedWeight,
      nominalUtilizationPercentage: assignedVolume / item.truck.volumeCapacity * 100,
      usableUtilizationPercentage: assignedVolume / item.truck.usableVolume * 100,
      remainingUsableVolume: item.truck.usableVolume - assignedVolume
    };
  });
  const unassigned = pos.filter(po => !assigned.has(po.id)).map(po => {
    const maxVolume = Math.max(0, ...available.map(truck => truck.usableVolume));
    const reason = po.volume > maxVolume + 1e-9
      ? "PO is larger than every available truck's usable volume."
      : payloadEnabled && po.weight !== null && !available.some(truck => truck.usablePayload !== null && po.weight <= truck.usablePayload + 1e-9)
        ? "PO exceeds every configured usable payload limit."
        : "No suitable available truck remained for this geographic group.";
    return { po, reason };
  });

  return { allocations: resultAllocations, groups: groupResults, unassigned, payloadEnabled };
}

module.exports = { allocation, normalizeInput, groupPOs, haversineKm };
