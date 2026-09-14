(function () {
  "use strict";

  var core = window.SnakeCore;
  if (!core) {
    throw new Error("SnakeCore failed to load");
  }

  var BOARD_SIZE = 20;
  var WARMUP_TICKS = 20;
  var ACTIONS = ["left", "forward", "right"];
  var GROUP = {
    VIS_R1R6: 0,
    OLF_ORN_FOOD: 6,
    OLF_ORN_DANGER: 7,
    MECH_BRISTLE: 10,
    CX_EPG: 25,
    CX_PFN: 26,
    CX_FC: 27,
    CX_HDELTA: 28,
    GUS_GRN_SWEET: 32,
    GNG_DESC: 35
  };

  var dom = {};
  var worker = null;
  var brainReady = false;
  var game = null;
  var random = null;
  var cohorts = null;
  var groupRanges = null;
  var paused = false;
  var pendingSteps = 0;
  var warmupRemaining = WARMUP_TICKS;
  var decisionTicks = 0;
  var readoutSums = [0, 0, 0];
  var latestRates = [0, 0, 0];
  var latestSensors = null;
  var neuralTick = 0;
  var completedGames = 0;
  var sequenceIndex = 0;
  var restartAtTick = null;
  var decisions = [];
  var logicalCanvasSize = 640;
  var canvasScale = 1;

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    [
      "board", "status-pill", "status-light", "status-text", "arena-overlay",
      "overlay-title", "overlay-detail", "score", "length", "moves", "games",
      "tick-count", "pause-button", "step-button", "new-button", "reset-button",
      "window-select", "seed-input", "restart-check", "chosen-action",
      "decision-margin", "decision-glyph", "neuron-count", "edge-count",
      "firing-count", "active-groups", "tick-time", "readout-count",
      "decision-log"
    ].forEach(function (id) {
      dom[id] = byId(id);
    });
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function setStatus(message, kind) {
    dom["status-text"].textContent = message;
    dom["status-pill"].classList.remove("ready", "error");
    if (kind) dom["status-pill"].classList.add(kind);
  }

  function showOverlay(title, detail, spinner) {
    dom["overlay-title"].textContent = title;
    dom["overlay-detail"].textContent = detail;
    dom["arena-overlay"].querySelector(".loader").style.display = spinner ? "block" : "none";
    dom["arena-overlay"].classList.remove("hidden");
  }

  function hideOverlay() {
    dom["arena-overlay"].classList.add("hidden");
  }

  function setControlsEnabled(enabled) {
    dom["pause-button"].disabled = !enabled;
    dom["step-button"].disabled = !enabled;
    dom["new-button"].disabled = !enabled;
    dom["reset-button"].disabled = !enabled;
  }

  function buildGroupRanges(groupIds) {
    var ranges = {};
    if (!groupIds || !groupIds.length) return ranges;
    var start = 0;
    var active = groupIds[0];

    for (var i = 1; i <= groupIds.length; i++) {
      if (i === groupIds.length || groupIds[i] !== active) {
        ranges[active] = { start: start, end: i, size: i - start };
        if (i < groupIds.length) {
          start = i;
          active = groupIds[i];
        }
      }
    }
    return ranges;
  }

  function availableRanges(groupIds) {
    var ranges = [];
    for (var i = 0; i < groupIds.length; i++) {
      var range = groupRanges[groupIds[i]];
      if (range && range.size > 0) ranges.push(range);
    }
    return ranges;
  }

  function locateCombinedIndex(ranges, offset) {
    var cursor = offset;
    for (var i = 0; i < ranges.length; i++) {
      if (cursor < ranges[i].size) return ranges[i].start + cursor;
      cursor -= ranges[i].size;
    }
    return ranges[ranges.length - 1].end - 1;
  }

  function partitionGroups(groupIds, perLane) {
    var ranges = availableRanges(groupIds);
    var lanes = [[], [], []];
    var total = ranges.reduce(function (sum, range) {
      return sum + range.size;
    }, 0);
    var sampleCount = Math.min(perLane * 3, total);

    if (!total) return lanes;
    for (var i = 0; i < sampleCount; i++) {
      var offset = Math.floor((i + 0.5) * total / sampleCount);
      lanes[i % 3].push(locateCombinedIndex(ranges, offset));
    }
    return lanes;
  }

  function sampleGroups(groupIds, count) {
    var ranges = availableRanges(groupIds);
    var total = ranges.reduce(function (sum, range) {
      return sum + range.size;
    }, 0);
    var sampleCount = Math.min(count, total);
    var result = [];

    if (!total) return result;
    for (var i = 0; i < sampleCount; i++) {
      var offset = Math.floor((i + 0.5) * total / sampleCount);
      result.push(locateCombinedIndex(ranges, offset));
    }
    return result;
  }

  function createCohorts(groupIds) {
    groupRanges = buildGroupRanges(groupIds);
    var result = {
      foodVision: partitionGroups([GROUP.VIS_R1R6], 192),
      danger: partitionGroups([GROUP.OLF_ORN_DANGER, GROUP.MECH_BRISTLE], 128),
      foodOdor: sampleGroups([GROUP.OLF_ORN_FOOD], 160),
      arousal: sampleGroups([GROUP.CX_EPG], 72),
      reward: sampleGroups([GROUP.GUS_GRN_SWEET], 128),
      readout: partitionGroups(
        [GROUP.GNG_DESC, GROUP.CX_PFN, GROUP.CX_HDELTA, GROUP.CX_FC],
        256
      )
    };
    result.collision = result.danger[0].concat(result.danger[1], result.danger[2]);
    return result;
  }

  function pushCohort(indices, intensities, cohort, intensity) {
    if (!cohort || intensity <= 0) return;
    for (var i = 0; i < cohort.length; i++) {
      indices.push(cohort[i]);
      intensities.push(intensity);
    }
  }

  function computeSensors() {
    if (!game) {
      return {
        food: { left: 0, forward: 0, right: 0, distance: 0, proximity: 0 },
        danger: { left: 0, forward: 0, right: 0 }
      };
    }
    return {
      food: core.foodCueWeights(game),
      danger: core.senseDanger(game, 3)
    };
  }

  function updateSustainedStimulus() {
    if (!brainReady || !game || !cohorts) return;

    latestSensors = computeSensors();
    var indices = [];
    var intensities = [];

    for (var lane = 0; lane < ACTIONS.length; lane++) {
      var command = ACTIONS[lane];
      var foodLevel = latestSensors.food[command];
      var dangerLevel = latestSensors.danger[command];

      if (foodLevel > 0.001) {
        pushCohort(indices, intensities, cohorts.foodVision[lane], 0.18 + 0.72 * foodLevel);
      }
      if (dangerLevel > 0.001) {
        pushCohort(indices, intensities, cohorts.danger[lane], 0.24 + 0.86 * dangerLevel);
      }
    }

    if (game.food) {
      pushCohort(
        indices,
        intensities,
        cohorts.foodOdor,
        0.09 + 0.18 * latestSensors.food.proximity
      );
    }
    pushCohort(indices, intensities, cohorts.arousal, 0.055);

    var typedIndices = new Uint32Array(indices);
    var typedIntensities = new Float32Array(intensities);
    worker.postMessage({
      type: "setStimulusState",
      indices: typedIndices,
      intensities: typedIntensities
    }, [typedIndices.buffer, typedIntensities.buffer]);

    renderSensors();
  }

  function pulse(cohort, intensity) {
    if (!brainReady || !cohort || !cohort.length) return;
    var indices = new Uint32Array(cohort);
    var intensities = new Float32Array(cohort.length);
    intensities.fill(intensity);
    worker.postMessage({
      type: "stimulate",
      indices: indices,
      intensities: intensities
    }, [indices.buffer, intensities.buffer]);
  }

  function seededGameRandom() {
    var parsed = Number.parseInt(dom["seed-input"].value, 10);
    var baseSeed = Number.isFinite(parsed) ? parsed : 783;
    var mixed = (baseSeed + Math.imul(sequenceIndex + 1, 0x9e3779b9)) >>> 0;
    sequenceIndex++;
    return core.createSeededRandom(mixed);
  }

  function startNewGame() {
    random = seededGameRandom();
    game = core.createInitialState({
      width: BOARD_SIZE,
      height: BOARD_SIZE,
      random: random
    });
    paused = false;
    pendingSteps = 0;
    restartAtTick = null;
    decisionTicks = 0;
    readoutSums = [0, 0, 0];
    latestRates = [0, 0, 0];
    dom["pause-button"].textContent = "Pause game";
    hideOverlay();
    updateSustainedStimulus();
    renderGame();
    renderOutputs(latestRates, null);
    setStatus("Connectome is controlling the board", "ready");
  }

  function resetBrain() {
    if (!brainReady) return;
    worker.postMessage({ type: "reset" });
    warmupRemaining = WARMUP_TICKS;
    decisionTicks = 0;
    readoutSums = [0, 0, 0];
    latestRates = [0, 0, 0];
    restartAtTick = null;
    updateSustainedStimulus();
    showOverlay("Brain reset", "Warming neural activity for " + WARMUP_TICKS + " ticks", true);
    dom["chosen-action"].textContent = "Warming up";
    dom["decision-margin"].textContent = "voltages cleared";
    setStatus("Warming the reset connectome");
  }

  function setPaused(nextPaused) {
    paused = nextPaused;
    pendingSteps = 0;
    decisionTicks = 0;
    readoutSums = [0, 0, 0];
    dom["pause-button"].textContent = paused ? "Resume game" : "Pause game";
    setStatus(
      paused ? "Board paused; connectome still ticking" : "Connectome is controlling the board",
      "ready"
    );
  }

  function countCohortSpikes(fireState, cohort) {
    var count = 0;
    for (var i = 0; i < cohort.length; i++) {
      if (fireState[cohort[i]]) count++;
    }
    return count;
  }

  function accumulateReadouts(fireState) {
    for (var lane = 0; lane < 3; lane++) {
      readoutSums[lane] += countCohortSpikes(fireState, cohorts.readout[lane]);
    }
    decisionTicks++;

    var partial = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      partial[i] = readoutSums[i] / (cohorts.readout[i].length * decisionTicks);
    }
    renderOutputs(partial, null);
  }

  function finalReadoutRates() {
    return [0, 1, 2].map(function (lane) {
      var denominator = cohorts.readout[lane].length * Math.max(1, decisionTicks);
      return denominator ? readoutSums[lane] / denominator : 0;
    });
  }

  function performDecision() {
    latestRates = finalReadoutRates();
    var selection = core.chooseRelativeCommand({
      left: latestRates[0],
      forward: latestRates[1],
      right: latestRates[2]
    });
    var previousSteps = game.steps;
    game = core.stepSnake(game, selection.command, random);

    renderOutputs(latestRates, selection.command);
    renderDecision(selection);
    appendDecision(previousSteps + 1, selection.command, latestRates, game.lastEvent);

    if (game.lastEvent === "ate") {
      pulse(cohorts.reward, 1.25);
    } else if (game.lastEvent === "collision") {
      pulse(cohorts.collision, 1.35);
    }

    if (!game.alive) {
      completedGames++;
      if (dom["restart-check"].checked) {
        restartAtTick = neuralTick + 12;
        showOverlay(
          game.lastEvent === "won" ? "Board cleared" : "Connectome chose a fatal move",
          "No safety override. Next game begins after 12 neural ticks.",
          false
        );
      } else {
        restartAtTick = null;
        showOverlay(
          game.lastEvent === "won" ? "Board cleared" : "Connectome chose a fatal move",
          "No safety override was applied. Use New game to continue.",
          false
        );
      }
    } else {
      updateSustainedStimulus();
    }

    if (pendingSteps > 0) pendingSteps--;
    decisionTicks = 0;
    readoutSums = [0, 0, 0];
    renderGame();
  }

  function shouldCollectDecision() {
    if (!game || !game.alive) return false;
    if (!paused) return true;
    return pendingSteps > 0;
  }

  function handleTick(message) {
    neuralTick = message.tickCount;
    dom["tick-count"].textContent = formatCount(neuralTick);
    dom["firing-count"].textContent = formatCount(message.firedNeurons);

    if (warmupRemaining > 0) {
      warmupRemaining--;
      dom["chosen-action"].textContent = "Warming up";
      dom["decision-margin"].textContent = warmupRemaining + " neural ticks remaining";
      if (warmupRemaining === 0) {
        hideOverlay();
        setStatus("Connectome is controlling the board", "ready");
      }
      return;
    }

    if (game && !game.alive) {
      if (restartAtTick !== null && neuralTick >= restartAtTick) startNewGame();
      return;
    }

    if (!shouldCollectDecision()) return;

    accumulateReadouts(message.fireState);
    var windowSize = Number.parseInt(dom["window-select"].value, 10) || 5;
    if (decisionTicks >= windowSize) performDecision();
  }

  function handleStats(message) {
    dom["tick-time"].textContent = message.avgTickMs.toFixed(1) + " ms";
    dom["active-groups"].textContent =
      formatCount(message.activeGroups) + " / " + formatCount(message.totalGroups);
    dom["firing-count"].textContent = formatCount(message.firedNeurons);
  }

  function handleWorkerMessage(event) {
    var message = event.data;
    if (message.type === "ready") {
      brainReady = true;
      cohorts = createCohorts(message.groupId);
      dom["neuron-count"].textContent = formatCount(message.neuronCount);
      dom["edge-count"].textContent = formatCount(message.edgeCount);
      dom["readout-count"].textContent = formatCount(
        cohorts.readout[0].length + cohorts.readout[1].length + cohorts.readout[2].length
      );
      setControlsEnabled(true);
      warmupRemaining = WARMUP_TICKS;
      startNewGame();
      showOverlay(
        "Connectome ready",
        "Warming activity for " + WARMUP_TICKS + " neural ticks before the first move",
        true
      );
      setStatus("Warming the connectome");
      worker.postMessage({ type: "start" });
      return;
    }

    if (message.type === "tick") {
      handleTick(message);
    } else if (message.type === "stats") {
      handleStats(message);
    } else if (message.type === "error") {
      fail(message.message);
    }
  }

  function fail(message) {
    setStatus("Could not start the experiment", "error");
    showOverlay(
      "Connectome could not load",
      message + " Serve the repository over HTTP and use a modern browser.",
      false
    );
    setControlsEnabled(false);
  }

  function renderSensors() {
    if (!latestSensors) latestSensors = computeSensors();
    ACTIONS.forEach(function (command) {
      var food = latestSensors.food[command] || 0;
      var danger = latestSensors.danger[command] || 0;
      byId("food-" + command + "-bar").style.width = (food * 100).toFixed(1) + "%";
      byId("danger-" + command + "-bar").style.width = (danger * 100).toFixed(1) + "%";
      byId("input-" + command).textContent = food.toFixed(2) + " / " + danger.toFixed(2);
    });
  }

  function renderOutputs(rates, selected) {
    var maxRate = Math.max(rates[0], rates[1], rates[2]);
    ACTIONS.forEach(function (command, index) {
      var rate = rates[index] || 0;
      var relativeWidth = maxRate > 0 ? rate / maxRate * 100 : 0;
      byId("output-" + command + "-bar").style.width = relativeWidth.toFixed(1) + "%";
      byId("output-" + command).textContent = (rate * 100).toFixed(3) + "%";
      var row = document.querySelector('.readout[data-command="' + command + '"]');
      row.classList.toggle("selected", selected === command);
    });
  }

  function renderDecision(selection) {
    var glyphs = { left: "↰", forward: "↑", right: "↱" };
    dom["chosen-action"].textContent = selection.command;
    dom["decision-glyph"].textContent = glyphs[selection.command];
    dom["decision-margin"].textContent =
      selection.margin === 0
        ? "exact tie resolved forward"
        : "winning margin " + (selection.margin * 100).toFixed(3) + "%";
  }

  function appendDecision(number, command, rates, eventName) {
    decisions.unshift({
      number: number,
      command: command,
      rates: rates.slice(),
      eventName: eventName
    });
    decisions = decisions.slice(0, 12);
    dom["decision-log"].textContent = "";

    decisions.forEach(function (entry) {
      var row = document.createElement("tr");
      var indexCell = document.createElement("td");
      var choiceCell = document.createElement("td");
      var rateCell = document.createElement("td");
      var eventCell = document.createElement("td");

      indexCell.textContent = entry.number;
      choiceCell.textContent = entry.command;
      choiceCell.className = "choice";
      rateCell.textContent = entry.rates.map(function (rate) {
        return (rate * 100).toFixed(3);
      }).join(" / ");
      eventCell.textContent = entry.eventName;
      if (entry.eventName === "collision") eventCell.className = "fatal";

      row.appendChild(indexCell);
      row.appendChild(choiceCell);
      row.appendChild(rateCell);
      row.appendChild(eventCell);
      dom["decision-log"].appendChild(row);
    });
  }

  function roundedRect(context, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function resizeCanvas() {
    var rect = dom.board.getBoundingClientRect();
    logicalCanvasSize = Math.max(280, Math.floor(rect.width || 640));
    canvasScale = Math.min(window.devicePixelRatio || 1, 2);
    dom.board.width = Math.floor(logicalCanvasSize * canvasScale);
    dom.board.height = Math.floor(logicalCanvasSize * canvasScale);
    renderGame();
  }

  function drawGrid(context, size, cell) {
    context.save();
    context.strokeStyle = "rgba(188, 224, 211, 0.055)";
    context.lineWidth = 1;
    for (var i = 1; i < BOARD_SIZE; i++) {
      var p = Math.round(i * cell) + 0.5;
      context.beginPath();
      context.moveTo(p, 0);
      context.lineTo(p, size);
      context.stroke();
      context.beginPath();
      context.moveTo(0, p);
      context.lineTo(size, p);
      context.stroke();
    }
    context.restore();
  }

  function drawSensorRays(context, cell) {
    if (!game || !latestSensors) return;
    var head = game.snake[0];
    var startX = (head.x + 0.5) * cell;
    var startY = (head.y + 0.5) * cell;

    ACTIONS.forEach(function (command) {
      var directionIndex = core.rotateDirection(game.direction, command);
      var direction = core.DIRECTIONS[directionIndex];
      var danger = latestSensors.danger[command] || 0;
      var endX = startX + direction.x * cell * 3;
      var endY = startY + direction.y * cell * 3;
      context.save();
      context.strokeStyle = danger > 0
        ? "rgba(255, 111, 97, " + (0.18 + danger * 0.35) + ")"
        : "rgba(86, 217, 208, 0.10)";
      context.setLineDash([3, 5]);
      context.lineWidth = Math.max(1, cell * 0.045);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
      context.restore();
    });
  }

  function renderGame() {
    if (!dom.board) return;
    var context = dom.board.getContext("2d");
    var size = logicalCanvasSize;
    var cell = size / BOARD_SIZE;
    context.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
    context.clearRect(0, 0, size, size);
    context.fillStyle = "#070b12";
    context.fillRect(0, 0, size, size);
    drawGrid(context, size, cell);

    if (!game) return;
    drawSensorRays(context, cell);

    if (game.food) {
      var foodX = (game.food.x + 0.5) * cell;
      var foodY = (game.food.y + 0.5) * cell;
      var glow = context.createRadialGradient(foodX, foodY, 0, foodX, foodY, cell * 0.72);
      glow.addColorStop(0, "rgba(255, 196, 94, 0.58)");
      glow.addColorStop(1, "rgba(255, 196, 94, 0)");
      context.fillStyle = glow;
      context.fillRect(foodX - cell, foodY - cell, cell * 2, cell * 2);
      context.fillStyle = "#ffc45e";
      context.beginPath();
      context.arc(foodX, foodY, cell * 0.24, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#fff1b6";
      context.beginPath();
      context.arc(foodX - cell * 0.07, foodY - cell * 0.08, cell * 0.065, 0, Math.PI * 2);
      context.fill();
    }

    for (var i = game.snake.length - 1; i >= 0; i--) {
      var segment = game.snake[i];
      var inset = cell * (i === 0 ? 0.10 : 0.15);
      var x = segment.x * cell + inset;
      var y = segment.y * cell + inset;
      var width = cell - inset * 2;
      var alpha = Math.max(0.38, 1 - i / Math.max(8, game.snake.length * 1.3));
      roundedRect(context, x, y, width, width, cell * 0.2);
      context.fillStyle = i === 0
        ? "#b9ff66"
        : "rgba(103, 230, 99, " + alpha.toFixed(3) + ")";
      context.fill();
    }

    var head = game.snake[0];
    var facing = core.DIRECTIONS[game.direction];
    var headCenterX = (head.x + 0.5) * cell;
    var headCenterY = (head.y + 0.5) * cell;
    context.fillStyle = "#132016";
    context.beginPath();
    context.arc(
      headCenterX + facing.x * cell * 0.19,
      headCenterY + facing.y * cell * 0.19,
      cell * 0.075,
      0,
      Math.PI * 2
    );
    context.fill();

    dom.score.textContent = game.score;
    dom.length.textContent = game.snake.length;
    dom.moves.textContent = game.steps;
    dom.games.textContent = completedGames;
  }

  function bindControls() {
    dom["pause-button"].addEventListener("click", function () {
      setPaused(!paused);
    });

    dom["step-button"].addEventListener("click", function () {
      if (!brainReady || !game || !game.alive || warmupRemaining > 0) return;
      paused = true;
      pendingSteps = 1;
      decisionTicks = 0;
      readoutSums = [0, 0, 0];
      dom["pause-button"].textContent = "Resume game";
      setStatus("Collecting spikes for one brain-decided move", "ready");
    });

    dom["new-button"].addEventListener("click", function () {
      if (brainReady) startNewGame();
    });

    dom["reset-button"].addEventListener("click", resetBrain);

    dom["seed-input"].addEventListener("change", function () {
      sequenceIndex = 0;
    });

    dom["window-select"].addEventListener("change", function () {
      decisionTicks = 0;
      readoutSums = [0, 0, 0];
    });

    dom["restart-check"].addEventListener("change", function () {
      if (game && !game.alive && dom["restart-check"].checked) {
        restartAtTick = neuralTick + 12;
      }
    });
  }

  async function loadConnectome() {
    if (window.location.protocol === "file:") {
      fail("Browsers block the connectome fetch from a file URL.");
      return;
    }

    try {
      setStatus("Fetching compressed connectome");
      worker = new Worker("../js/sim-worker.js");
      worker.onmessage = handleWorkerMessage;
      worker.onerror = function (event) {
        fail(event.message || "The neural simulation worker stopped.");
      };

      var response = await fetch("../data/connectome.bin.gz");
      if (!response.ok) {
        throw new Error("Connectome request returned HTTP " + response.status + ".");
      }
      var buffer = await response.arrayBuffer();
      setStatus("Parsing and grouping 139,255 neurons");
      showOverlay(
        "Building the neural graph",
        "Decompressing the connectome and remapping 2.7M weighted synapses",
        true
      );
      worker.postMessage({ type: "init", buffer: buffer }, [buffer]);
    } catch (error) {
      fail(error.message || String(error));
    }
  }

  function initialize() {
    cacheDom();
    bindControls();
    latestSensors = computeSensors();
    resizeCanvas();

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resizeCanvas).observe(dom.board.parentElement);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }

    loadConnectome();
  }

  document.addEventListener("DOMContentLoaded", initialize);
}());
