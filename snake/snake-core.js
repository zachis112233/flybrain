(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SnakeCore = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DIRECTIONS = [
    { x: 0, y: -1, name: "up" },
    { x: 1, y: 0, name: "right" },
    { x: 0, y: 1, name: "down" },
    { x: -1, y: 0, name: "left" }
  ];

  var COMMANDS = ["left", "forward", "right"];

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function sameCell(a, b) {
    return Boolean(a && b && a.x === b.x && a.y === b.y);
  }

  function rotateDirection(direction, command) {
    var delta = command === "left" ? -1 : command === "right" ? 1 : 0;
    return (direction + delta + DIRECTIONS.length) % DIRECTIONS.length;
  }

  function nextCell(head, direction) {
    var vector = DIRECTIONS[direction];
    return { x: head.x + vector.x, y: head.y + vector.y };
  }

  function outsideBoard(cell, width, height) {
    return cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height;
  }

  function rayDanger(state, command, range) {
    var maxRange = range || 3;
    var direction = rotateDirection(state.direction, command);
    var cursor = state.snake[0];

    for (var step = 1; step <= maxRange; step++) {
      cursor = nextCell(cursor, direction);
      var blocked = outsideBoard(cursor, state.width, state.height);
      if (!blocked) {
        for (var i = 1; i < state.snake.length; i++) {
          if (sameCell(cursor, state.snake[i])) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        return (maxRange - step + 1) / maxRange;
      }
    }
    return 0;
  }

  function senseDanger(state, range) {
    return {
      left: rayDanger(state, "left", range),
      forward: rayDanger(state, "forward", range),
      right: rayDanger(state, "right", range)
    };
  }

  function foodCueWeights(state) {
    var head = state.snake[0];
    if (!state.food) {
      return { left: 0, forward: 0, right: 0, distance: 0, proximity: 0 };
    }

    var dx = state.food.x - head.x;
    var dy = state.food.y - head.y;
    var facing = DIRECTIONS[state.direction];
    var forwardComponent = dx * facing.x + dy * facing.y;
    var rightComponent = dx * (-facing.y) + dy * facing.x;
    var componentTotal = Math.abs(forwardComponent) + Math.abs(rightComponent) || 1;
    var distance = Math.abs(dx) + Math.abs(dy);
    var proximity = 1 / (1 + distance / 8);
    var weights = { left: 0, forward: 0, right: 0 };

    if (forwardComponent > 0) {
      weights.forward += forwardComponent / componentTotal;
    } else if (forwardComponent < 0) {
      var behind = Math.abs(forwardComponent) / componentTotal;
      weights.left += behind / 2;
      weights.right += behind / 2;
    }

    if (rightComponent > 0) {
      weights.right += rightComponent / componentTotal;
    } else if (rightComponent < 0) {
      weights.left += Math.abs(rightComponent) / componentTotal;
    }

    return {
      left: clamp(weights.left * (0.45 + 0.55 * proximity), 0, 1),
      forward: clamp(weights.forward * (0.45 + 0.55 * proximity), 0, 1),
      right: clamp(weights.right * (0.45 + 0.55 * proximity), 0, 1),
      distance: distance,
      proximity: proximity
    };
  }

  function finiteScore(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function chooseRelativeCommand(scores) {
    var clean = {
      left: finiteScore(scores && scores.left),
      forward: finiteScore(scores && scores.forward),
      right: finiteScore(scores && scores.right)
    };
    var tieOrder = ["forward", "left", "right"];
    var command = tieOrder[0];
    var best = clean[command];

    for (var i = 1; i < tieOrder.length; i++) {
      var candidate = tieOrder[i];
      if (clean[candidate] > best) {
        best = clean[candidate];
        command = candidate;
      }
    }

    var ordered = [clean.left, clean.forward, clean.right].sort(function (a, b) {
      return b - a;
    });

    return {
      command: command,
      scores: clean,
      margin: ordered[0] - ordered[1]
    };
  }

  function createSeededRandom(seed) {
    var state = (seed >>> 0) || 0x9e3779b9;
    return function () {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }

  function placeFood(width, height, snake, random) {
    var open = [];
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var occupied = false;
        for (var i = 0; i < snake.length; i++) {
          if (snake[i].x === x && snake[i].y === y) {
            occupied = true;
            break;
          }
        }
        if (!occupied) {
          open.push({ x: x, y: y });
        }
      }
    }
    if (!open.length) return null;
    var index = Math.floor(clamp(random(), 0, 0.999999999) * open.length);
    return open[index];
  }

  function createInitialState(options) {
    var settings = options || {};
    var width = settings.width || 20;
    var height = settings.height || 20;
    var random = settings.random || Math.random;
    var length = Math.min(4, width - 2);
    var headX = Math.floor(width / 2);
    var headY = Math.floor(height / 2);
    var snake = [];

    for (var i = 0; i < length; i++) {
      snake.push({ x: headX - i, y: headY });
    }

    return {
      width: width,
      height: height,
      snake: snake,
      food: placeFood(width, height, snake, random),
      direction: 1,
      score: 0,
      steps: 0,
      alive: true,
      lastEvent: "start",
      lastCommand: "forward"
    };
  }

  function stepSnake(state, command, random) {
    if (!state.alive) {
      return Object.assign({}, state, { lastEvent: "dead" });
    }

    var rng = random || Math.random;
    var nextDirection = rotateDirection(state.direction, command);
    var next = nextCell(state.snake[0], nextDirection);
    var ate = sameCell(next, state.food);
    var collision = outsideBoard(next, state.width, state.height);
    var occupiedLength = ate ? state.snake.length : state.snake.length - 1;

    for (var i = 0; !collision && i < occupiedLength; i++) {
      if (sameCell(next, state.snake[i])) collision = true;
    }

    if (collision) {
      return Object.assign({}, state, {
        direction: nextDirection,
        alive: false,
        steps: state.steps + 1,
        lastEvent: "collision",
        lastCommand: command
      });
    }

    var snake = [next].concat(state.snake);
    if (!ate) snake.pop();
    var food = ate ? placeFood(state.width, state.height, snake, rng) : state.food;
    var won = ate && food === null;

    return Object.assign({}, state, {
      snake: snake,
      food: food,
      direction: nextDirection,
      score: state.score + (ate ? 1 : 0),
      steps: state.steps + 1,
      alive: !won,
      lastEvent: won ? "won" : ate ? "ate" : "move",
      lastCommand: command
    });
  }

  return {
    DIRECTIONS: DIRECTIONS,
    COMMANDS: COMMANDS,
    clamp: clamp,
    sameCell: sameCell,
    rotateDirection: rotateDirection,
    nextCell: nextCell,
    outsideBoard: outsideBoard,
    rayDanger: rayDanger,
    senseDanger: senseDanger,
    foodCueWeights: foodCueWeights,
    chooseRelativeCommand: chooseRelativeCommand,
    createSeededRandom: createSeededRandom,
    placeFood: placeFood,
    createInitialState: createInitialState,
    stepSnake: stepSnake
  };
}));
