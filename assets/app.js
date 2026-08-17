(() => {
  "use strict";

  const DATA_PATHS = {
    config: "./data/model_config.json",
    archetypes: "./data/archetypes.json",
    exitProfiles: "./data/exit_profiles.json",
    destinationProfiles: "./data/destination_profiles.json",
    regions: "./data/regions.geojson",
  };

  const TRACKS = ["NT", "TT"];
  const TRACK_COLORS = { NT: "#1f5f8b", TT: "#b5523c" };
  const TRACK_LABELS = {
    NT: "No Transition (NT)",
    TT: "Twin Transition (TT)",
  };
  const REGION_IDS = Array.from({ length: 38 }, (_, index) => index + 23);
  const FORMAT_INT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
  const FORMAT_1 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const ui = {};
  const app = {
    data: null,
    simulation: null,
    timer: null,
    running: false,
    regionElements: new Map(),
    mapProjection: null,
  };

  class RNG {
    constructor(seed) {
      let value = Number(seed) >>> 0;
      if (!value) value = 0x6d2b79f5;
      this.state = value;
      this.spareNormal = null;
    }

    random() {
      let t = (this.state += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    uniform(min = 0, max = 1) {
      return min + (max - min) * this.random();
    }

    normal(mean = 0, sd = 1) {
      if (this.spareNormal !== null) {
        const value = this.spareNormal;
        this.spareNormal = null;
        return mean + sd * value;
      }
      let u = 0;
      let v = 0;
      while (u <= Number.EPSILON) u = this.random();
      while (v <= Number.EPSILON) v = this.random();
      const radius = Math.sqrt(-2 * Math.log(u));
      const theta = 2 * Math.PI * v;
      this.spareNormal = radius * Math.sin(theta);
      return mean + sd * radius * Math.cos(theta);
    }

    weightedIndex(weights) {
      let total = 0;
      for (const value of weights) total += Number.isFinite(value) && value > 0 ? value : 0;
      if (total <= 0) return Math.floor(this.random() * weights.length);
      let threshold = this.random() * total;
      for (let index = 0; index < weights.length; index += 1) {
        threshold -= Number.isFinite(weights[index]) && weights[index] > 0 ? weights[index] : 0;
        if (threshold <= 0) return index;
      }
      return weights.length - 1;
    }

    poisson(lambda) {
      if (!(lambda > 0)) return 0;
      if (lambda < 30) {
        const limit = Math.exp(-lambda);
        let product = 1;
        let count = 0;
        do {
          count += 1;
          product *= this.random();
        } while (product > limit);
        return count - 1;
      }
      return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    }

    sampleWithoutReplacement(length, count, excludedIndex = -1) {
      const output = [];
      const seen = new Set();
      const target = Math.min(count, Math.max(0, length - (excludedIndex >= 0 ? 1 : 0)));
      while (output.length < target) {
        const value = Math.floor(this.random() * length);
        if (value === excludedIndex || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
      }
      return output;
    }
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clamp01 = (value) => clamp(value, 0, 1);

  function normalise(weights) {
    const cleaned = weights.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
    const total = cleaned.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return cleaned.map(() => 1 / cleaned.length);
    return cleaned.map((value) => value / total);
  }

  function sampleLabel(rng, probabilities, labels = null) {
    const index = rng.weightedIndex(probabilities);
    return labels ? labels[index] : index;
  }

  function stochasticRound(rng, value) {
    if (!(value > 0)) return 0;
    const base = Math.floor(value);
    return base + (rng.random() < value - base ? 1 : 0);
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function gini(values) {
    const valid = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    const n = valid.length;
    if (!n) return 0;
    const total = valid.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return 0;
    let weighted = 0;
    for (let index = 0; index < n; index += 1) weighted += (index + 1) * valid[index];
    return clamp((2 * weighted) / (n * total) - (n + 1) / n, 0, 1);
  }


  class LiveLiteSimulation {
    constructor(data, params) {
      this.data = data;
      this.params = { ...params };
      this.rng = new RNG(params.seed);
      this.scenario = data.config.scenarios[params.scenario];
      this.regionIndex = new Map(REGION_IDS.map((id, index) => [id, index]));
      this.agents = [];
      this.month = 0;
      this.history = [];
      this.netMigration = { NT: 0, TT: 0 };
      this.regionNetMigration = {
        NT: Array(REGION_IDS.length).fill(0),
        TT: Array(REGION_IDS.length).fill(0),
      };
      this.initialRegionCounts = Array(REGION_IDS.length).fill(0);
      this.events = { moves: 0, out: 0, inflow: 0, deaths: 0, births: 0 };
      this.macroShocks = new Map();
      this.nextAgentId = 0;
      this.caches = null;
      this.archetypeWeights = normalise(data.archetypes.map((item) => item.weight));
      this.archetypeRegionAffinity = this.buildArchetypeRegionAffinity();
      this.setupPopulation();
      this.buildSocialLinks();
      this.caches = this.computeCaches();
      this.captureHistory();
    }

    buildArchetypeRegionAffinity() {
      return this.data.archetypes.map((archetype) => {
        const output = Array(REGION_IDS.length).fill(0);
        archetype.destination_profile_probs.forEach((profileProbability, profileIndex) => {
          const profile = this.data.destinationProfiles[profileIndex];
          REGION_IDS.forEach((regionId, regionPosition) => {
            output[regionPosition] += profileProbability * Number(profile.region_weights[String(regionId)] || 0);
          });
        });
        return normalise(output.map((value) => value + 1e-8));
      });
    }

    allocateRegionTargets(totalAgents) {
      const weights = this.data.config.region_metadata.map((region) => region.population_weight);
      const raw = weights.map((weight) => weight * totalAgents);
      const targets = raw.map((value) => Math.floor(value));
      let remaining = totalAgents - targets.reduce((sum, value) => sum + value, 0);
      const order = raw
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((a, b) => b.fraction - a.fraction);
      for (let index = 0; index < remaining; index += 1) targets[order[index % order.length].index] += 1;
      return targets;
    }

    setupPopulation() {
      const targets = this.allocateRegionTargets(this.params.agentCount);
      this.initialRegionCounts = targets.slice();
      targets.forEach((count, regionPosition) => {
        const regionId = REGION_IDS[regionPosition];
        const weights = this.data.archetypes.map(
          (archetype, archetypeIndex) =>
            this.archetypeWeights[archetypeIndex] * (this.archetypeRegionAffinity[archetypeIndex][regionPosition] + 1e-7),
        );
        for (let index = 0; index < count; index += 1) {
          const archetypeIndex = this.rng.weightedIndex(weights);
          this.agents.push(this.instantiateAgent(archetypeIndex, regionId, TRACKS));
        }
      });
    }

    instantiateAgent(archetypeIndex, regionId, activeTracks, parent = null) {
      const archetype = this.data.archetypes[archetypeIndex];
      const age = parent ? 0 : Math.round(clamp(this.rng.normal(archetype.age.mean, archetype.age.sd), 0, 90));
      const sex = parent
        ? this.rng.random() < 0.5
          ? "F"
          : "M"
        : sampleLabel(this.rng, [archetype.sex_probs.M, archetype.sex_probs.F, archetype.sex_probs.O], ["M", "F", "O"]);
      const income = parent
        ? null
        : Math.max(
            0,
            Math.round(
              Math.exp(this.rng.normal(Math.log(Math.max(500, archetype.income.median)), archetype.income.log_sd)),
            ),
          );
      const questions = {};
      for (const [questionId, summary] of Object.entries(archetype.questions)) {
        questions[questionId] = parent
          ? parent.questions[questionId]
          : clamp(this.rng.normal(summary.mean, summary.sd), 1, 5);
      }
      const exitProfile = parent
        ? -1
        : this.rng.weightedIndex(archetype.exit_profile_probs);
      const destinationProfile = parent
        ? parent.destinationProfile
        : this.rng.weightedIndex(archetype.destination_profile_probs);

      const states = {};
      const buffers = {};
      for (const track of TRACKS) {
        const alive = activeTracks.includes(track);
        states[track] = {
          alive,
          regionId: alive ? regionId : -1,
          tenure: 0,
          exitKind: "none",
          exitMonth: -1,
          exitRegion: -1,
        };
        buffers[track] = {
          friend: Array(12).fill(0),
          neighbor: Array(12).fill(0),
        };
      }

      return {
        id: this.nextAgentId++,
        archetypeIndex,
        age,
        sex,
        income,
        internet: parent ? 0 : sampleLabel(this.rng, archetype.internet_probs, [0, 1, 2, 3]),
        education: parent ? 0 : sampleLabel(this.rng, archetype.education_probs),
        health: parent ? 3 : sampleLabel(this.rng, archetype.health_probs, [1, 2, 3, 4, 5]),
        activity: parent ? 0 : sampleLabel(this.rng, archetype.activity_probs),
        publicTransport: parent
          ? 3
          : sampleLabel(this.rng, archetype.public_transport_probs, [1, 2, 3, 4, 5]),
        questions,
        exitProfile,
        destinationProfile,
        heterogeneityBase: this.rng.uniform(-0.2, 0.2),
        canMigrate: age >= 18,
        baseRegionId: regionId,
        states,
        buffers,
        friends: [],
        neighbors: [],
      };
    }

    buildSocialLinks() {
      const total = this.agents.length;
      const byRegion = this.groupAgentsByBaseRegion();
      for (let index = 0; index < total; index += 1) {
        const agent = this.agents[index];
        const candidateIndices = this.rng.sampleWithoutReplacement(total, Math.min(25, total - 1), index);
        const scored = candidateIndices
          .map((candidateIndex) => ({
            candidateIndex,
            score: this.friendSimilarity(agent, this.agents[candidateIndex]) + this.rng.uniform(0, 0.05),
          }))
          .sort((a, b) => b.score - a.score);
        agent.friends = scored.slice(0, this.params.friendDegree).map((item) => item.candidateIndex);

        const regionMeta = this.data.regionMetadata.get(agent.baseRegionId);
        const eligibleRegions = [agent.baseRegionId, ...(regionMeta ? regionMeta.nearby_ids : [])];
        const candidates = [];
        for (const regionId of eligibleRegions) {
          for (const candidateIndex of byRegion.get(regionId) || []) {
            if (candidateIndex !== index) candidates.push(candidateIndex);
          }
        }
        agent.neighbors = this.sampleFromList(candidates, this.params.neighborDegree);
      }
    }

    groupAgentsByBaseRegion() {
      const output = new Map();
      this.agents.forEach((agent, index) => {
        if (!output.has(agent.baseRegionId)) output.set(agent.baseRegionId, []);
        output.get(agent.baseRegionId).push(index);
      });
      return output;
    }

    sampleFromList(values, count) {
      if (!values.length || count <= 0) return [];
      const output = [];
      const available = values.slice();
      const target = Math.min(count, available.length);
      while (output.length < target) {
        const index = Math.floor(this.rng.random() * available.length);
        output.push(available[index]);
        available.splice(index, 1);
      }
      return output;
    }

    friendSimilarity(a, b) {
      const ageDifference = Math.abs(a.age - b.age);
      const incomeA = Math.max(0, a.income || 0);
      const incomeB = Math.max(0, b.income || 0);
      const incomeDifference = Math.abs(Math.log1p(incomeA) - Math.log1p(incomeB));
      const educationDifference = Math.abs((a.education || 0) - (b.education || 0));
      const internetDifference = Math.abs((a.internet || 0) - (b.internet || 0));
      return 1 / (1 + ageDifference / 10 + incomeDifference + educationDifference / 5 + internetDifference / 2);
    }

    attachSocialLinks(agentIndex) {
      const agent = this.agents[agentIndex];
      const total = this.agents.length;
      if (total <= 1) return;
      const candidates = this.rng.sampleWithoutReplacement(total, Math.min(20, total - 1), agentIndex);
      agent.friends = candidates
        .map((candidateIndex) => ({ candidateIndex, score: this.friendSimilarity(agent, this.agents[candidateIndex]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, this.params.friendDegree)
        .map((item) => item.candidateIndex);

      const eligibleRegions = [agent.baseRegionId, ...(this.data.regionMetadata.get(agent.baseRegionId)?.nearby_ids || [])];
      const neighbours = [];
      this.agents.forEach((candidate, candidateIndex) => {
        if (candidateIndex !== agentIndex && eligibleRegions.includes(candidate.baseRegionId)) neighbours.push(candidateIndex);
      });
      agent.neighbors = this.sampleFromList(neighbours, this.params.neighborDegree);
    }

    computeCaches() {
      const output = {};
      for (const track of TRACKS) {
        const counts = Array(REGION_IDS.length).fill(0);
        const incomeLists = Array.from({ length: REGION_IDS.length }, () => []);
        let total = 0;
        for (const agent of this.agents) {
          const state = agent.states[track];
          if (!state.alive) continue;
          total += 1;
          const position = this.regionIndex.get(state.regionId);
          if (position === undefined) continue;
          counts[position] += 1;
          if (Number.isFinite(agent.income) && agent.income > 0) incomeLists[position].push(agent.income);
        }
        output[track] = {
          total,
          counts,
          medianIncome: incomeLists.map((values) => median(values)),
        };
      }
      return output;
    }

    cdfAt(cdf, tenure) {
      if (tenure <= 0) return 0;
      if (tenure >= 120) return cdf[119];
      return cdf[tenure - 1];
    }

    hazardFromCdf(agent, tenure) {
      if (agent.exitProfile < 0) return 0;
      const cdf = this.data.exitProfiles[agent.exitProfile].cdf;
      const previous = this.cdfAt(cdf, tenure);
      const current = this.cdfAt(cdf, tenure + 1);
      if (previous >= 1) return 0;
      return clamp01((current - previous) / (1 - previous));
    }

    ageMoveMultiplier(age) {
      if (!Number.isFinite(age)) return 1;
      if (age < 18) return 0;
      if (age <= 34) return 1;
      if (age <= 49) return 0.9;
      if (age <= 64) return 0.75;
      if (age <= 74) return 0.55;
      return 0.35;
    }

    remoteWorkAgeMultiplier(age) {
      if (!Number.isFinite(age)) return 0.5;
      if (age < 18) return 0;
      if (age <= 34) return 1;
      if (age <= 49) return 0.5;
      if (age <= 64) return 0.2;
      return 0.1;
    }

    policyAdjustedProbability(baseProbability, agent, track) {
      if (track === "NT") return baseProbability;
      let effect = 0;
      const transitionStrength = this.params.transitionStrength;
      for (const question of this.data.config.questions) {
        const coefficient = Number(this.scenario.coefficients[question.id] || 1);
        const sensitivity = Number(agent.questions[question.id] || 3);
        const scaledSensitivity = (sensitivity - 1) / 4;
        effect += question.weight * scaledSensitivity * (coefficient - 1) * transitionStrength;
      }
      effect *= this.params.preferenceSatisfactionScale;
      return clamp01(baseProbability * Math.max(0, 1 - effect));
    }

    activityMultiplier(activity) {
      if (activity === 0) return 1.0;
      if (activity === 1) return 0.85;
      if (activity === 2) return 1.15;
      if (activity === 3) return 0.95;
      return 1.05;
    }

    stateMultiplier(agent, track, cache) {
      const state = agent.states[track];
      const regionPosition = this.regionIndex.get(state.regionId);
      let incomeMultiplier = 1;
      const regionMedian = regionPosition === undefined ? null : cache.medianIncome[regionPosition];
      if (Number.isFinite(agent.income) && agent.income > 0 && Number.isFinite(regionMedian) && regionMedian > 0) {
        const ratio = agent.income / regionMedian;
        if (ratio < 0.75) incomeMultiplier = 1.15;
        else if (ratio < 1) incomeMultiplier = 1.05;
        else if (ratio > 1.25) incomeMultiplier = 0.9;
      }
      const internetMultiplier = agent.internet === 1 ? 1.05 : agent.internet === 2 ? 0.95 : 1;
      const educationMultiplier = agent.education >= 5 ? 1.05 : 1;
      return clamp(
        this.activityMultiplier(agent.activity) * incomeMultiplier * internetMultiplier * educationMultiplier,
        0.6,
        1.4,
      );
    }

    macroMultiplier() {
      if (this.params.macroNoiseScale <= 0) return 1;
      const year = Math.ceil(this.month / 12);
      const key = `${this.params.scenario}|${year}`;
      if (!this.macroShocks.has(key)) this.macroShocks.set(key, this.rng.uniform(-0.2, 0.2));
      return Math.max(0, 1 + this.params.macroNoiseScale * this.macroShocks.get(key));
    }

    socialMultiplier(agent, track) {
      const friendLag = agent.buffers[track].friend[0] || 0;
      const neighbourLag = agent.buffers[track].neighbor[0] || 0;
      const friendMultiplier = 1 / (1 + this.params.friendStrength * friendLag);
      const neighbourMultiplier = 1 / (1 + this.params.neighborStrength * neighbourLag);
      return friendMultiplier * neighbourMultiplier;
    }

    relocate(agent, track, cache) {
      const state = agent.states[track];
      const currentRegionPosition = this.regionIndex.get(state.regionId);
      const profile = this.data.destinationProfiles[agent.destinationProfile];
      const candidateIds = [];
      const weights = [];
      REGION_IDS.forEach((regionId, regionPosition) => {
        if (regionId === state.regionId) return;
        const baseWeight = Math.max(0.0001, Number(profile.region_weights[String(regionId)] || 0));
        const share = cache.total > 0 ? cache.counts[regionPosition] / cache.total : 0;
        const congestionPenalty = 1 / (1 + this.params.congestionStrength * clamp01(share));
        const remoteBoost =
          1 + this.params.remoteWorkStrength * this.remoteWorkAgeMultiplier(agent.age) * (1 - clamp01(share));
        candidateIds.push(regionId);
        weights.push(baseWeight * congestionPenalty * Math.max(1, remoteBoost));
      });
      if (!candidateIds.length) return false;
      const destination = candidateIds[this.rng.weightedIndex(weights)];
      const destinationPosition = this.regionIndex.get(destination);
      if (currentRegionPosition !== undefined) this.regionNetMigration[track][currentRegionPosition] -= 1;
      if (destinationPosition !== undefined) this.regionNetMigration[track][destinationPosition] += 1;
      state.regionId = destination;
      state.tenure = 0;
      this.events.moves += 1;
      return true;
    }

    exitAgent(agent, track) {
      const state = agent.states[track];
      const regionPosition = this.regionIndex.get(state.regionId);
      if (regionPosition !== undefined) this.regionNetMigration[track][regionPosition] -= 1;
      state.alive = false;
      state.exitKind = "outmigration";
      state.exitMonth = this.month;
      state.exitRegion = state.regionId;
      this.netMigration[track] -= 1;
      this.events.out += 1;
    }

    monthlyMigration() {
      const macroMultiplier = this.macroMultiplier();
      for (const agent of this.agents) {
        if (!agent.canMigrate) continue;
        for (const track of TRACKS) {
          const state = agent.states[track];
          if (!state.alive) continue;
          state.tenure += 1;
          const baseHazard = this.hazardFromCdf(agent, state.tenure);
          const attachment = 1 / (1 + 0.1 * this.params.placeAttachmentScale * (state.tenure / 12));
          const policyProbability = this.policyAdjustedProbability(baseHazard * attachment, agent, track);
          const ageMultiplier = this.ageMoveMultiplier(agent.age);
          const heterogeneityMultiplier = Math.max(
            0,
            1 + this.params.heterogeneityNoiseScale * agent.heterogeneityBase,
          );
          const microLimit = 0.2 * this.params.microNoiseScale;
          const microNoise = microLimit > 0 ? this.rng.uniform(-microLimit, microLimit) : 0;
          const probability = clamp01(
            policyProbability *
              this.stateMultiplier(agent, track, this.caches[track]) *
              ageMultiplier *
              heterogeneityMultiplier *
              macroMultiplier *
              this.socialMultiplier(agent, track) +
              microNoise,
          );
          const effectiveProbability = Math.min(probability, this.params.exitThreshold);
          if (this.rng.random() >= effectiveProbability) continue;

          const relocationWindow = this.month > 0 && this.month % 6 === 0;
          const relocateProbability = clamp01(this.params.internalRelocationProb * ageMultiplier);
          if (relocationWindow && this.rng.random() < relocateProbability) {
            this.relocate(agent, track, this.caches[track]);
          } else {
            this.exitAgent(agent, track);
          }
        }
      }
    }

    monthlyGrowthRate(annualRate) {
      const adjusted = Math.max(
        0,
        annualRate * this.params.scenarioImpactScale * this.params.populationGrowthScale,
      );
      return Math.pow(1 + adjusted, 1 / 12) - 1;
    }

    chooseInflowRegion(track, provisionalAge) {
      const cache = this.caches[track];
      const total = Math.max(0, cache.total);
      const alpha = clamp01(this.params.remoteWorkStrength / 5) * this.remoteWorkAgeMultiplier(provisionalAge);
      const weights = cache.counts.map((population) => {
        const largeRegionWeight = population + 1;
        const smallRegionWeight = total - population + 1;
        return (1 - alpha) * largeRegionWeight + alpha * smallRegionWeight;
      });
      return REGION_IDS[this.rng.weightedIndex(weights)];
    }

    chooseArchetypeForRegion(regionId) {
      const regionPosition = this.regionIndex.get(regionId);
      const weights = this.data.archetypes.map(
        (archetype, archetypeIndex) =>
          this.archetypeWeights[archetypeIndex] *
          (this.archetypeRegionAffinity[archetypeIndex][regionPosition] + 1e-7),
      );
      return this.rng.weightedIndex(weights);
    }

    performInflow(track, count) {
      for (let number = 0; number < count; number += 1) {
        const provisionalArchetype = this.rng.weightedIndex(this.archetypeWeights);
        const provisionalAge = clamp(
          this.rng.normal(
            this.data.archetypes[provisionalArchetype].age.mean,
            this.data.archetypes[provisionalArchetype].age.sd,
          ),
          0,
          90,
        );
        const regionId = this.chooseInflowRegion(track, provisionalAge);
        const archetypeIndex = this.chooseArchetypeForRegion(regionId);
        const agent = this.instantiateAgent(archetypeIndex, regionId, [track]);
        this.agents.push(agent);
        this.attachSocialLinks(this.agents.length - 1);
        this.netMigration[track] += 1;
        const regionPosition = this.regionIndex.get(regionId);
        if (regionPosition !== undefined) this.regionNetMigration[track][regionPosition] += 1;
        this.events.inflow += 1;
      }
    }

    performBirth(track, mothers) {
      if (!mothers.length) return;
      const mother = mothers[Math.floor(this.rng.random() * mothers.length)];
      const regionId = mother.states[track].regionId;
      const child = this.instantiateAgent(mother.archetypeIndex, regionId, [track], mother);
      child.destinationProfile = mother.destinationProfile;
      this.agents.push(child);
      this.attachSocialLinks(this.agents.length - 1);
      this.events.births += 1;
    }

    annualDeathProbability(age) {
      if (age < 40) return 0.003;
      if (age < 60) return 0.007;
      if (age < 75) return 0.015;
      if (age < 90) return 0.04;
      return 0.1;
    }

    populationProcesses() {
      for (const track of TRACKS) {
        const cache = this.caches[track];
        const inflowRate = Math.min(0.2, this.monthlyGrowthRate(this.scenario.mg_annual));
        const inflowCount = stochasticRound(this.rng, cache.total * inflowRate);
        if (inflowCount > 0) this.performInflow(track, inflowCount);
      }

      this.caches = this.computeCaches();
      for (const track of TRACKS) {
        const aliveBeforeBirths = this.agents.filter((agent) => agent.states[track].alive);
        const naturalGrowthRate = Math.min(0.2, this.monthlyGrowthRate(this.scenario.ng_annual));
        const birthCount = this.rng.poisson(aliveBeforeBirths.length * naturalGrowthRate);
        const mothers = aliveBeforeBirths.filter(
          (agent) => agent.sex === "F" && agent.age >= 18 && agent.age <= 45,
        );
        for (let birth = 0; birth < birthCount; birth += 1) this.performBirth(track, mothers);

        for (const agent of aliveBeforeBirths) {
          const annualProbability = clamp01(
            this.annualDeathProbability(agent.age) * this.params.populationGrowthScale,
          );
          const monthlyProbability = 1 - Math.pow(1 - annualProbability, 1 / 12);
          if (this.rng.random() < monthlyProbability) {
            const state = agent.states[track];
            state.alive = false;
            state.exitKind = "death";
            state.exitMonth = this.month;
            state.exitRegion = state.regionId;
            this.events.deaths += 1;
          }
        }
      }
    }

    currentSocialSignal(agent, track, type) {
      const links = type === "friend" ? agent.friends : agent.neighbors;
      if (!links.length) return 0;
      const tenures = [];
      for (const index of links) {
        const linked = this.agents[index];
        if (!linked) continue;
        const state = linked.states[track];
        if (state && state.alive) tenures.push(state.tenure);
      }
      if (!tenures.length) return 0;
      return Math.min(1, tenures.reduce((sum, value) => sum + value, 0) / tenures.length / 120);
    }

    updateSocialBuffers() {
      for (const agent of this.agents) {
        for (const track of TRACKS) {
          for (const type of ["friend", "neighbor"]) {
            const buffer = agent.buffers[track][type];
            buffer.push(this.currentSocialSignal(agent, track, type));
            while (buffer.length > 12) buffer.shift();
          }
        }
      }
    }

    step() {
      if (this.month >= this.params.durationMonths) return false;
      this.events = { moves: 0, out: 0, inflow: 0, deaths: 0, births: 0 };
      this.caches = this.computeCaches();
      this.monthlyMigration();
      this.caches = this.computeCaches();
      this.populationProcesses();

      if (this.month > 0 && this.month % 12 === 0) {
        for (const agent of this.agents) {
          agent.age += 1;
          if (agent.age >= 18) agent.canMigrate = true;
        }
      }

      this.updateSocialBuffers();
      this.month += 1;
      this.caches = this.computeCaches();
      this.captureHistory();
      return this.month < this.params.durationMonths;
    }

    captureHistory() {
      const record = { month: this.month };
      for (const track of TRACKS) {
        const alive = this.agents.filter((agent) => agent.states[track].alive);
        record[`${track.toLowerCase()}Pop`] = alive.length;
        record[`${track.toLowerCase()}NetMig`] = this.netMigration[track];
        record[`${track.toLowerCase()}Gini`] = gini(alive.map((agent) => agent.income));
      }
      record.gap = record.ttPop - record.ntPop;
      this.history.push(record);
    }

    regionMetrics() {
      const metrics = new Map();
      REGION_IDS.forEach((regionId, position) => {
        const initial = this.initialRegionCounts[position];
        const nt = this.caches.NT.counts[position];
        const tt = this.caches.TT.counts[position];
        metrics.set(regionId, {
          initial,
          nt,
          tt,
          gap: nt > 0 ? ((tt - nt) / nt) * 100 : tt > 0 ? 100 : 0,
          ntChange: initial > 0 ? ((nt - initial) / initial) * 100 : 0,
          ttChange: initial > 0 ? ((tt - initial) / initial) * 100 : 0,
          ntShare: this.caches.NT.total > 0 ? nt / this.caches.NT.total : 0,
          ttShare: this.caches.TT.total > 0 ? tt / this.caches.TT.total : 0,
          ntNetMig: this.regionNetMigration.NT[position],
          ttNetMig: this.regionNetMigration.TT[position],
        });
      });
      return metrics;
    }

    aggregateCsv() {
      const lines = [
        "level,month,region_id,region_name,track,track_label,population,net_migration,income_gini,population_change_pct",
      ];
      for (const row of this.history) {
        for (const track of TRACKS) {
          const key = track.toLowerCase();
          lines.push(
            [
              "national",
              row.month,
              "",
              "",
              track,
              `"${TRACK_LABELS[track]}"`,
              row[`${key}Pop`],
              row[`${key}NetMig`],
              row[`${key}Gini`].toFixed(6),
              "",
            ].join(","),
          );
        }
      }
      const regionMetrics = this.regionMetrics();
      for (const region of this.data.config.region_metadata) {
        const metric = regionMetrics.get(region.id);
        for (const track of TRACKS) {
          const population = track === "NT" ? metric.nt : metric.tt;
          const netMigration = track === "NT" ? metric.ntNetMig : metric.ttNetMig;
          const change = track === "NT" ? metric.ntChange : metric.ttChange;
          lines.push(
            [
              "region_snapshot",
              this.month,
              region.id,
              `"${String(region.name).replaceAll('"', '""')}"`,
              track,
              `"${TRACK_LABELS[track]}"`,
              population,
              netMigration,
              "",
              change.toFixed(6),
            ].join(","),
          );
        }
      }
      return lines.join("\n");
    }
  }

  function cacheUi() {
    const ids = [
      "sidebar",
      "sidebar-scrim",
      "mobile-toggle",
      "scenario-select",
      "seed-input",
      "agent-count",
      "duration-select",
      "speed-select",
      "setup-button",
      "run-button",
      "step-button",
      "reset-button",
      "transition-strength",
      "transition-strength-value",
      "remote-work-strength",
      "remote-work-strength-value",
      "relocation-prob",
      "relocation-prob-value",
      "congestion-strength",
      "congestion-strength-value",
      "friend-strength",
      "friend-strength-value",
      "neighbor-strength",
      "neighbor-strength-value",
      "map-indicator",
      "chart-indicator",
      "download-button",
      "model-status",
      "display-status",
      "scenario-title",
      "summary-month",
      "summary-nt",
      "summary-tt",
      "summary-gap",
      "map-subtitle",
      "run-pill",
      "region-map",
      "region-layer",
      "map-tooltip",
      "legend-bar",
      "legend-min",
      "legend-mid",
      "legend-max",
      "trajectory-chart",
      "chart-title",
      "chart-legend",
      "event-moves",
      "event-out",
      "event-in",
      "event-deaths",
      "loading",
      "loading-text",
      "error-box",
    ];
    for (const id of ids) ui[id] = document.getElementById(id);
  }

  async function loadData() {
    const [config, archetypes, exitProfiles, destinationProfiles, regions] = await Promise.all(
      Object.values(DATA_PATHS).map(async (path) => {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
        return response.json();
      }),
    );
    const regionMetadata = new Map(config.region_metadata.map((region) => [region.id, region]));
    return { config, archetypes, exitProfiles, destinationProfiles, regions, regionMetadata };
  }

  function currentParams() {
    return {
      scenario: ui["scenario-select"].value,
      seed: Number(ui["seed-input"].value || 66),
      agentCount: Number(ui["agent-count"].value || 600),
      durationMonths: Number(ui["duration-select"].value || 120),
      transitionStrength: Number(ui["transition-strength"].value || 6),
      remoteWorkStrength: Number(ui["remote-work-strength"].value || 1),
      internalRelocationProb: Number(ui["relocation-prob"].value || 0.5),
      congestionStrength: Number(ui["congestion-strength"].value || 10),
      friendStrength: Number(ui["friend-strength"].value || 1),
      neighborStrength: Number(ui["neighbor-strength"].value || 1),
      friendDegree: app.data.config.defaults.friend_degree,
      neighborDegree: app.data.config.defaults.neighbor_degree,
      exitThreshold: app.data.config.defaults.exit_threshold,
      placeAttachmentScale: app.data.config.defaults.place_attachment_scale,
      scenarioImpactScale: app.data.config.defaults.scenario_impact_scale,
      preferenceSatisfactionScale: app.data.config.defaults.preference_satisfaction_scale,
      populationGrowthScale: app.data.config.defaults.population_growth_scale,
      microNoiseScale: app.data.config.defaults.micro_noise_scale,
      heterogeneityNoiseScale: app.data.config.defaults.heterogeneity_noise_scale,
      macroNoiseScale: app.data.config.defaults.macro_noise_scale,
    };
  }

  function populateScenarioOptions() {
    ui["scenario-select"].innerHTML = "";
    for (const [key, scenario] of Object.entries(app.data.config.scenarios)) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = scenario.label;
      ui["scenario-select"].appendChild(option);
    }
    ui["scenario-select"].value = app.data.config.defaults.scenario;
  }

  function setupSimulation() {
    pauseSimulation();
    ui["model-status"].textContent = "Setting up";
    ui["run-pill"].textContent = "Generating agents";
    const params = currentParams();
    app.simulation = new LiveLiteSimulation(app.data, params);
    ui["model-status"].textContent = "Ready";
    ui["run-pill"].textContent = "Setup complete";
    ui["run-button"].textContent = "Run";
    updateAll();
  }

  function startSimulation() {
    if (!app.simulation) setupSimulation();
    if (app.simulation.month >= app.simulation.params.durationMonths) return;
    pauseSimulation();
    app.running = true;
    ui["run-button"].textContent = "Pause";
    ui["model-status"].textContent = "Running";
    ui["run-pill"].textContent = "Running";
    const speed = Math.max(1, Number(ui["speed-select"].value || 12));
    app.timer = window.setInterval(() => {
      if (!app.simulation) return;
      const keepRunning = app.simulation.step();
      updateAll();
      if (!keepRunning) {
        pauseSimulation();
        ui["model-status"].textContent = "Complete";
        ui["run-pill"].textContent = "Simulation complete";
      }
    }, Math.max(20, Math.round(1000 / speed)));
  }

  function pauseSimulation() {
    if (app.timer !== null) window.clearInterval(app.timer);
    app.timer = null;
    app.running = false;
    if (ui["run-button"]) ui["run-button"].textContent = "Run";
    if (app.simulation && app.simulation.month < app.simulation.params.durationMonths) {
      ui["model-status"].textContent = "Paused";
      ui["run-pill"].textContent = "Paused";
    }
  }

  function stepSimulation() {
    pauseSimulation();
    if (!app.simulation) setupSimulation();
    if (app.simulation.month < app.simulation.params.durationMonths) app.simulation.step();
    updateAll();
    if (app.simulation.month >= app.simulation.params.durationMonths) {
      ui["model-status"].textContent = "Complete";
      ui["run-pill"].textContent = "Simulation complete";
    }
  }

  function setupMap() {
    const features = app.data.regions.features;
    const coordinates = [];
    for (const feature of features) collectCoordinates(feature.geometry.coordinates, coordinates);
    const longitudes = coordinates.map((coordinate) => coordinate[0]);
    const latitudes = coordinates.map((coordinate) => coordinate[1]);
    const bounds = {
      minX: Math.min(...longitudes),
      maxX: Math.max(...longitudes),
      minY: Math.min(...latitudes),
      maxY: Math.max(...latitudes),
    };
    const width = 760;
    const height = 570;
    const margin = 24;
    const scale = Math.min(
      (width - 2 * margin) / (bounds.maxX - bounds.minX),
      (height - 2 * margin) / (bounds.maxY - bounds.minY),
    );
    const usedWidth = (bounds.maxX - bounds.minX) * scale;
    const usedHeight = (bounds.maxY - bounds.minY) * scale;
    const offsetX = (width - usedWidth) / 2;
    const offsetY = (height - usedHeight) / 2;
    app.mapProjection = ([longitude, latitude]) => [
      offsetX + (longitude - bounds.minX) * scale,
      height - offsetY - (latitude - bounds.minY) * scale,
    ];

    ui["region-layer"].innerHTML = "";
    app.regionElements.clear();
    for (const feature of features) {
      const regionId = Number(feature.properties.region_id);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", geometryPath(feature.geometry, app.mapProjection));
      path.setAttribute("class", "region-shape");
      path.dataset.regionId = String(regionId);
      path.addEventListener("mousemove", (event) => showMapTooltip(event, regionId));
      path.addEventListener("mouseleave", hideMapTooltip);
      ui["region-layer"].appendChild(path);
      app.regionElements.set(regionId, path);
    }
  }

  function collectCoordinates(value, output) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      output.push(value);
      return;
    }
    for (const item of value) collectCoordinates(item, output);
  }

  function geometryPath(geometry, projection) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const parts = [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        if (!ring.length) continue;
        const projected = ring.map(projection);
        parts.push(
          `M${projected[0][0].toFixed(2)},${projected[0][1].toFixed(2)}` +
            projected
              .slice(1)
              .map((point) => `L${point[0].toFixed(2)},${point[1].toFixed(2)}`)
              .join("") +
            "Z",
        );
      }
    }
    return parts.join("");
  }


  function mapMetricDefinition() {
    const value = ui["map-indicator"].value;
    const definitions = {
      gap: { key: "gap", label: "Twin Transition minus No Transition population difference", suffix: "%", diverging: true },
      "tt-change": { key: "ttChange", label: "Twin Transition population change", suffix: "%", diverging: true },
      "nt-change": { key: "ntChange", label: "No Transition population change", suffix: "%", diverging: true },
      "tt-share": { key: "ttShare", label: "Twin Transition population share", suffix: "%", diverging: false, percentage: true },
      "nt-share": { key: "ntShare", label: "No Transition population share", suffix: "%", diverging: false, percentage: true },
      "tt-netmig": { key: "ttNetMig", label: "Twin Transition cumulative net migration", suffix: "", diverging: true },
      "nt-netmig": { key: "ntNetMig", label: "No Transition cumulative net migration", suffix: "", diverging: true },
    };
    return definitions[value];
  }

  function percentile(values, probability) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
  }

  function interpolateColor(a, b, t) {
    const result = a.map((value, index) => Math.round(value + (b[index] - value) * clamp01(t)));
    return `rgb(${result[0]}, ${result[1]}, ${result[2]})`;
  }

  function divergingColor(value, limit) {
    const negative = [45, 111, 157];
    const neutral = [247, 247, 245];
    const positive = [181, 82, 60];
    if (value < 0) return interpolateColor(neutral, negative, Math.abs(value) / limit);
    return interpolateColor(neutral, positive, value / limit);
  }

  function sequentialColor(value, min, max) {
    const low = [237, 244, 248];
    const high = [31, 95, 139];
    const t = max > min ? (value - min) / (max - min) : 0.5;
    return interpolateColor(low, high, t);
  }

  function updateMap() {
    if (!app.simulation) return;
    const definition = mapMetricDefinition();
    const metrics = app.simulation.regionMetrics();
    const values = REGION_IDS.map((regionId) => {
      const raw = metrics.get(regionId)[definition.key];
      return definition.percentage ? raw * 100 : raw;
    });
    let min = Math.min(...values);
    let max = Math.max(...values);
    let limit = 1;
    if (definition.diverging) {
      limit = Math.max(0.5, percentile(values.map(Math.abs), 0.95), Math.abs(min), Math.abs(max));
      min = -limit;
      max = limit;
    }

    REGION_IDS.forEach((regionId, index) => {
      const element = app.regionElements.get(regionId);
      if (!element) return;
      const value = values[index];
      element.style.fill = definition.diverging
        ? divergingColor(value, limit)
        : sequentialColor(value, min, max);
      element.dataset.metricValue = String(value);
    });

    ui["map-subtitle"].textContent = `${definition.label} at month ${app.simulation.month}`;
    ui["display-status"].textContent = definition.label;
    ui["legend-min"].textContent = formatMapValue(min, definition);
    ui["legend-mid"].textContent = definition.diverging ? "0" : formatMapValue((min + max) / 2, definition);
    ui["legend-max"].textContent = formatMapValue(max, definition);
    ui["legend-bar"].style.background = definition.diverging
      ? "linear-gradient(90deg, #2d6f9d, #f7f7f5, #b5523c)"
      : "linear-gradient(90deg, #edf4f8, #1f5f8b)";
  }

  function formatMapValue(value, definition) {
    if (definition.suffix === "%") return `${FORMAT_1.format(value)}%`;
    return FORMAT_INT.format(value);
  }

  function showMapTooltip(event, regionId) {
    if (!app.simulation) return;
    const definition = mapMetricDefinition();
    const metric = app.simulation.regionMetrics().get(regionId);
    const region = app.data.regionMetadata.get(regionId);
    const raw = metric[definition.key];
    const value = definition.percentage ? raw * 100 : raw;
    ui["map-tooltip"].innerHTML = `
      <div class="tooltip-title">${region.name}</div>
      <div class="tooltip-row"><span>${definition.label}</span><span>${formatMapValue(value, definition)}</span></div>
      <div class="tooltip-row"><span>Initial population</span><span>${FORMAT_INT.format(metric.initial)}</span></div>
      <div class="tooltip-row"><span>${TRACK_LABELS.NT}</span><span>${FORMAT_INT.format(metric.nt)}</span></div>
      <div class="tooltip-row"><span>${TRACK_LABELS.TT}</span><span>${FORMAT_INT.format(metric.tt)}</span></div>
    `;
    const mapRect = ui["region-map"].getBoundingClientRect();
    const wrapperRect = ui["region-map"].parentElement.getBoundingClientRect();
    ui["map-tooltip"].style.left = `${event.clientX - wrapperRect.left + 12}px`;
    ui["map-tooltip"].style.top = `${event.clientY - wrapperRect.top + 12}px`;
    ui["map-tooltip"].style.display = "block";
  }

  function hideMapTooltip() {
    ui["map-tooltip"].style.display = "none";
  }


  function chartDefinition() {
    const value = ui["chart-indicator"].value;
    const definitions = {
      population: {
        title: "Population trajectory",
        series: [
          { key: "ntPop", label: TRACK_LABELS.NT, color: TRACK_COLORS.NT },
          { key: "ttPop", label: TRACK_LABELS.TT, color: TRACK_COLORS.TT },
        ],
        format: (number) => FORMAT_INT.format(number),
        includeZero: false,
      },
      netmig: {
        title: "Cumulative net migration",
        series: [
          { key: "ntNetMig", label: TRACK_LABELS.NT, color: TRACK_COLORS.NT },
          { key: "ttNetMig", label: TRACK_LABELS.TT, color: TRACK_COLORS.TT },
        ],
        format: (number) => FORMAT_INT.format(number),
        includeZero: true,
      },
      gini: {
        title: "Income Gini trajectory",
        series: [
          { key: "ntGini", label: TRACK_LABELS.NT, color: TRACK_COLORS.NT },
          { key: "ttGini", label: TRACK_LABELS.TT, color: TRACK_COLORS.TT },
        ],
        format: (number) => Number(number).toFixed(2),
        includeZero: false,
      },
      gap: {
        title: "Twin Transition minus No Transition population gap",
        series: [{ key: "gap", label: "Twin Transition − No Transition", color: "#7656a7" }],
        format: (number) => FORMAT_INT.format(number),
        includeZero: true,
      },
    };
    return definitions[value];
  }

  function drawChart() {
    if (!app.simulation) return;
    const canvas = ui["trajectory-chart"];
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(300, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const definition = chartDefinition();
    ui["chart-title"].textContent = definition.title;
    ui["chart-legend"].innerHTML = definition.series
      .map(
        (series) =>
          `<span class="legend-item"><span class="legend-line" style="background:${series.color}"></span>${series.label}</span>`,
      )
      .join("");

    const history = app.simulation.history;
    const allValues = definition.series.flatMap((series) => history.map((row) => Number(row[series.key])));
    let minValue = Math.min(...allValues);
    let maxValue = Math.max(...allValues);
    if (definition.includeZero) {
      minValue = Math.min(minValue, 0);
      maxValue = Math.max(maxValue, 0);
    }
    if (maxValue === minValue) {
      maxValue += 1;
      minValue -= 1;
    }
    const padding = (maxValue - minValue) * 0.08;
    maxValue += padding;
    minValue -= padding;

    const margin = { left: 52, right: 18, top: 18, bottom: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxMonth = Math.max(app.simulation.params.durationMonths, 1);
    const x = (month) => margin.left + (month / maxMonth) * plotWidth;
    const y = (value) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

    context.lineWidth = 1;
    context.font = "11px Inter, system-ui, sans-serif";
    context.fillStyle = "#667085";
    context.strokeStyle = "#e1e6eb";
    for (let step = 0; step <= 4; step += 1) {
      const value = minValue + ((maxValue - minValue) * step) / 4;
      const py = y(value);
      context.beginPath();
      context.moveTo(margin.left, py);
      context.lineTo(width - margin.right, py);
      context.stroke();
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(definition.format(value), margin.left - 8, py);
    }

    const monthTicks = [0, Math.round(maxMonth / 2), maxMonth];
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const month of monthTicks) {
      context.fillText(String(month), x(month), height - margin.bottom + 9);
    }
    context.fillText("Month", margin.left + plotWidth / 2, height - 15);

    for (const series of definition.series) {
      context.beginPath();
      context.strokeStyle = series.color;
      context.lineWidth = 2.2;
      context.lineJoin = "round";
      context.lineCap = "round";
      history.forEach((row, index) => {
        const px = x(row.month);
        const py = y(Number(row[series.key]));
        if (index === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      });
      context.stroke();
    }
  }

  function updateSummary() {
    if (!app.simulation) return;
    const latest = app.simulation.history[app.simulation.history.length - 1];
    const scenarioLabel = app.data.config.scenarios[app.simulation.params.scenario].label;
    ui["scenario-title"].textContent = `${scenarioLabel} · ${TRACK_LABELS.NT} and ${TRACK_LABELS.TT}`;
    ui["summary-month"].textContent = String(app.simulation.month);
    ui["summary-nt"].textContent = FORMAT_INT.format(latest.ntPop);
    ui["summary-tt"].textContent = FORMAT_INT.format(latest.ttPop);
    ui["summary-gap"].textContent = `${latest.gap >= 0 ? "+" : ""}${FORMAT_INT.format(latest.gap)}`;
    ui["summary-gap"].style.color = latest.gap > 0 ? "#9f3f2d" : latest.gap < 0 ? "#245e89" : "#17212b";
    ui["event-moves"].textContent = FORMAT_INT.format(app.simulation.events.moves);
    ui["event-out"].textContent = FORMAT_INT.format(app.simulation.events.out);
    ui["event-in"].textContent = FORMAT_INT.format(app.simulation.events.inflow);
    ui["event-deaths"].textContent = FORMAT_INT.format(app.simulation.events.deaths);
  }

  function updateAll() {
    updateSummary();
    updateMap();
    drawChart();
  }

  function updateRangeLabels() {
    ui["transition-strength-value"].textContent = Number(ui["transition-strength"].value).toFixed(1);
    ui["remote-work-strength-value"].textContent = Number(ui["remote-work-strength"].value).toFixed(1);
    ui["relocation-prob-value"].textContent = Number(ui["relocation-prob"].value).toFixed(2);
    ui["congestion-strength-value"].textContent = String(Number(ui["congestion-strength"].value));
    ui["friend-strength-value"].textContent = Number(ui["friend-strength"].value).toFixed(1);
    ui["neighbor-strength-value"].textContent = Number(ui["neighbor-strength"].value).toFixed(1);
  }

  function downloadAggregateCsv() {
    if (!app.simulation) return;
    const blob = new Blob([app.simulation.aggregateCsv()], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `central_macedonia_ABM_live_lite_${app.simulation.params.scenario}_seed${app.simulation.params.seed}_month${app.simulation.month}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function showError(error) {
    ui["error-box"].style.display = "block";
    ui["error-box"].textContent = error instanceof Error ? error.message : String(error);
    ui["loading"].classList.add("hidden");
    console.error(error);
  }

  function bindEvents() {
    ui["setup-button"].addEventListener("click", setupSimulation);
    ui["reset-button"].addEventListener("click", setupSimulation);
    ui["run-button"].addEventListener("click", () => (app.running ? pauseSimulation() : startSimulation()));
    ui["step-button"].addEventListener("click", stepSimulation);
    ui["speed-select"].addEventListener("change", () => {
      if (app.running) startSimulation();
    });
    for (const id of [
      "transition-strength",
      "remote-work-strength",
      "relocation-prob",
      "congestion-strength",
      "friend-strength",
      "neighbor-strength",
    ]) {
      ui[id].addEventListener("input", updateRangeLabels);
    }
    ui["map-indicator"].addEventListener("change", updateMap);
    ui["chart-indicator"].addEventListener("change", drawChart);
    ui["download-button"].addEventListener("click", downloadAggregateCsv);
    window.addEventListener("resize", drawChart);

    ui["mobile-toggle"].addEventListener("click", () => {
      ui.sidebar.classList.toggle("open");
      ui["sidebar-scrim"].classList.toggle("open");
    });
    ui["sidebar-scrim"].addEventListener("click", () => {
      ui.sidebar.classList.remove("open");
      ui["sidebar-scrim"].classList.remove("open");
    });
  }

  async function initialise() {
    cacheUi();
    bindEvents();
    updateRangeLabels();
    try {
      ui["loading-text"].textContent = "Loading synthetic archetypes and regional geometry…";
      app.data = await loadData();
      populateScenarioOptions();
      setupMap();
      ui["loading-text"].textContent = "Generating the default synthetic population…";
      setupSimulation();
      ui["loading"].classList.add("hidden");

      window.MOBI_TWIN_LITE_TEST = {
        setup: () => setupSimulation(),
        step: (months = 1) => {
          pauseSimulation();
          for (let index = 0; index < months; index += 1) {
            if (!app.simulation.step()) break;
          }
          updateAll();
          return window.MOBI_TWIN_LITE_TEST.state();
        },
        state: () => {
          const latest = app.simulation.history[app.simulation.history.length - 1];
          return {
            month: app.simulation.month,
            ntPopulation: latest.ntPop,
            ttPopulation: latest.ttPop,
            agentsStored: app.simulation.agents.length,
            historyRows: app.simulation.history.length,
            regions: app.simulation.regionMetrics().size,
          };
        },
      };
      window.dispatchEvent(new CustomEvent("mobi-twin-lite-ready"));
    } catch (error) {
      showError(error);
    }
  }

  document.addEventListener("DOMContentLoaded", initialise);
})();
