const log = require('../util/log');
const Cast = require('../util/cast');
const BlockType = require('../extension-support/block-type');
const VariablePool = require('./variable-pool');
const jsexecute = require('./jsexecute');
const environment = require('./environment');
const {StackOpcode, InputOpcode, ValueType} = require('./enums.js')

// Imported for JSDoc types, not to actually use
// eslint-disable-next-line no-unused-vars
const {IntermediateStack, IntermediateInput, IntermediateScript, IntermediateRepresentation} = require('./intermediate');

/**
 * @fileoverview Convert intermediate representations to JavaScript functions.
 */

/* eslint-disable max-len */
/* eslint-disable prefer-template */

const sanitize = string => {
    if (typeof string !== 'string') {
        log.warn(`sanitize got unexpected type: ${typeof string}`);
        string = '' + string;
    }
    return JSON.stringify(string).slice(1, -1);
};

// Pen-related constants
const PEN_EXT = 'runtime.ext_pen';
const PEN_STATE = `${PEN_EXT}._getPenState(target)`;

/**
 * Variable pool used for factory function names.
 */
const factoryNameVariablePool = new VariablePool('factory');

/**
 * Variable pool used for generated functions (non-generator)
 */
const functionNameVariablePool = new VariablePool('fun');

/**
 * Variable pool used for generated generator functions.
 */
const generatorNameVariablePool = new VariablePool('gen');

/**
 * @typedef Input
 * @property {() => string} asNumber
 * @property {() => string} asNumberOrNaN
 * @property {() => string} asString
 * @property {() => string} asBoolean
 * @property {() => string} asColor
 * @property {() => string} asUnknown
 * @property {() => string} asSafe
 * @property {() => boolean} isAlwaysNumber
 * @property {() => boolean} isAlwaysNumberOrNaN
 * @property {() => boolean} isNeverNumber
 */

/**
 * @implements {Input}
 */
class TypedInput {
    constructor (source, type) {
        // for debugging
        if (typeof type !== 'number') throw new Error('type is invalid');
        this.source = source;
        this.type = type;
    }

    asNumber () {
        if (this.type === ValueType.NUMBER) return this.source;
        if (this.type === ValueType.NUMBER_OR_NAN) return `(${this.source} || 0)`;
        return `(+${this.source} || 0)`;
    }

    asNumberOrNaN () {
        if (this.type === ValueType.NUMBER || this.type === ValueType.NUMBER_OR_NAN) return this.source;
        return `(+${this.source})`;
    }

    asString () {
        if (this.type === ValueType.STRING) return this.source;
        return `("" + ${this.source})`;
    }

    asBoolean () {
        if (this.type === ValueType.BOOLEAN) return this.source;
        return `toBoolean(${this.source})`;
    }

    asColor () {
        return this.asUnknown();
    }

    asUnknown () {
        return this.source;
    }

    asSafe () {
        return this.asUnknown();
    }

    isAlwaysNumber () {
        return this.type === ValueType.NUMBER;
    }

    isAlwaysNumberOrNaN () {
        return this.type === ValueType.NUMBER || this.type === ValueType.NUMBER_OR_NAN;
    }

    isNeverNumber () {
        return false;
    }
}

/**
 * @implements {Input}
 */
class ConstantInput {
    constructor (constantValue, safe) {
        this.constantValue = constantValue;
        this.safe = safe;
    }

    asNumber () {
        // Compute at compilation time
        const numberValue = +this.constantValue;
        if (numberValue) {
            // It's important that we use the number's stringified value and not the constant value
            // Using the constant value allows numbers such as "010" to be interpreted as 8 (or SyntaxError in strict mode) instead of 10.
            return numberValue.toString();
        }
        // numberValue is one of 0, -0, or NaN
        if (Object.is(numberValue, -0)) {
            return '-0';
        }
        return '0';
    }

    asNumberOrNaN () {
        return this.asNumber();
    }

    asString () {
        return `"${sanitize('' + this.constantValue)}"`;
    }

    asBoolean () {
        // Compute at compilation time
        return Cast.toBoolean(this.constantValue).toString();
    }

    asColor () {
        // Attempt to parse hex code at compilation time
        if (/^#[0-9a-f]{6,8}$/i.test(this.constantValue)) {
            const hex = this.constantValue.substr(1);
            return Number.parseInt(hex, 16).toString();
        }
        return this.asUnknown();
    }

    asUnknown () {
        // Attempt to convert strings to numbers if it is unlikely to break things
        if (typeof this.constantValue === 'number') {
            // todo: handle NaN?
            return this.constantValue;
        }
        const numberValue = +this.constantValue;
        if (numberValue.toString() === this.constantValue) {
            return this.constantValue;
        }
        return this.asString();
    }

    asSafe () {
        if (this.safe) {
            return this.asUnknown();
        }
        return this.asString();
    }

    isAlwaysNumber () {
        const value = +this.constantValue;
        if (Number.isNaN(value)) {
            return false;
        }
        // Empty strings evaluate to 0 but should not be considered a number.
        if (value === 0) {
            return this.constantValue.toString().trim() !== '';
        }
        return true;
    }

    isAlwaysNumberOrNaN () {
        return this.isAlwaysNumber();
    }

    isNeverNumber () {
        return Number.isNaN(+this.constantValue);
    }
}

/**
 * @implements {Input}
 */
class VariableInput {
    constructor (source) {
        this.source = source;
        this.type = ValueType.UNKNOWN;
        /**
         * The value this variable was most recently set to, if any.
         * @type {Input}
         * @private
         */
        this._value = null;
    }

    /**
     * @param {Input} input The input this variable was most recently set to.
     */
    setInput (input) {
        if (input instanceof VariableInput) {
            // When being set to another variable, extract the value it was set to.
            // Otherwise, you may end up with infinite recursion in analysis methods when a variable is set to itself.
            if (input._value) {
                input = input._value;
            } else {
                this.type = ValueType.UNKNOWN;
                this._value = null;
                return;
            }
        }
        this._value = input;
        if (input instanceof TypedInput) {
            this.type = input.type;
        } else {
            this.type = ValueType.UNKNOWN;
        }
    }

    asNumber () {
        if (this.type === ValueType.NUMBER) return this.source;
        if (this.type === ValueType.NUMBER_OR_NAN) return `(${this.source} || 0)`;
        return `(+${this.source} || 0)`;
    }

    asNumberOrNaN () {
        if (this.type === ValueType.NUMBER || this.type === ValueType.NUMBER_OR_NAN) return this.source;
        return `(+${this.source})`;
    }

    asString () {
        if (this.type === ValueType.STRING) return this.source;
        return `("" + ${this.source})`;
    }

    asBoolean () {
        if (this.type === ValueType.BOOLEAN) return this.source;
        return `toBoolean(${this.source})`;
    }

    asColor () {
        return this.asUnknown();
    }

    asUnknown () {
        return this.source;
    }

    asSafe () {
        return this.asUnknown();
    }

    isAlwaysNumber () {
        if (this._value) {
            return this._value.isAlwaysNumber();
        }
        return false;
    }

    isAlwaysNumberOrNaN () {
        if (this._value) {
            return this._value.isAlwaysNumberOrNaN();
        }
        return false;
    }

    isNeverNumber () {
        if (this._value) {
            return this._value.isNeverNumber();
        }
        return false;
    }
}

const getNamesOfCostumesAndSounds = runtime => {
    const result = new Set();
    for (const target of runtime.targets) {
        if (target.isOriginal) {
            const sprite = target.sprite;
            for (const costume of sprite.costumes) {
                result.add(costume.name);
            }
            for (const sound of sprite.sounds) {
                result.add(sound.name);
            }
        }
    }
    return result;
};

const isSafeConstantForEqualsOptimization = input => {
    const numberValue = +input.constantValue;
    // Do not optimize 0
    if (!numberValue) {
        return false;
    }
    // Do not optimize numbers when the original form does not match
    return numberValue.toString() === input.constantValue.toString();
};

/**
 * A frame contains some information about the current substack being compiled.
 */
class Frame {
    constructor (isLoop) {
        /**
         * Whether the current stack runs in a loop (while, for)
         * @type {boolean}
         * @readonly
         */
        this.isLoop = isLoop;

        /**
         * Whether the current block is the last block in the stack.
         * @type {boolean}
         */
        this.isLastBlock = false;
    }
}

class JSGenerator {
    /**
     * @param {IntermediateScript} script
     * @param {IntermediateRepresentation} ir
     * @param {Target} target
     */
    constructor (script, ir, target) {
        this.script = script;
        this.ir = ir;
        this.target = target;
        this.source = '';

        /**
         * @type {Object.<string, VariableInput>}
         */
        this.variableInputs = {};

        this.isWarp = script.isWarp;
        this.isProcedure = script.isProcedure;
        this.warpTimer = script.warpTimer;

        /**
         * Stack of frames, most recent is last item.
         * @type {Frame[]}
         */
        this.frames = [];

        /**
         * The current Frame.
         * @type {Frame}
         */
        this.currentFrame = null;

        this.namesOfCostumesAndSounds = getNamesOfCostumesAndSounds(target.runtime);

        this.localVariables = new VariablePool('a');
        this._setupVariablesPool = new VariablePool('b');
        this._setupVariables = {};

        this.descendedIntoModulo = false;
        this.isInHat = false;

        this.debug = this.target.runtime.debug;
    }

    /**
     * Enter a new frame
     * @param {Frame} frame New frame.
     */
    pushFrame (frame) {
        this.frames.push(frame);
        this.currentFrame = frame;
    }

    /**
     * Exit the current frame
     */
    popFrame () {
        this.frames.pop();
        this.currentFrame = this.frames[this.frames.length - 1];
    }

    /**
     * @returns {boolean} true if the current block is the last command of a loop
     */
    isLastBlockInLoop () {
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            if (!frame.isLastBlock) {
                return false;
            }
            if (frame.isLoop) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {IntermediateInput} block Input node to compile.
     * @returns {Input} Compiled input.
     */
    descendInput (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case InputOpcode.PROCEDURE_ARG_BOOLEAN:
            return new TypedInput(`toBoolean(p${node.index})`, ValueType.BOOLEAN);
        case InputOpcode.PROCEDURE_ARG_STRING_NUMBER:
            return new TypedInput(`p${node.index}`, ValueType.UNKNOWN);

        case InputOpcode.COMPATIBILITY_LAYER:
            // Compatibility layer inputs never use flags.
            return new TypedInput(`(${this.generateCompatibilityLayerCall(block, false)})`, ValueType.UNKNOWN);

        case InputOpcode.CONSTANT:
            return this.safeConstantInput(node.value);

        case InputOpcode.SENSING_KEY_DOWN:
            return new TypedInput(`runtime.ioDevices.keyboard.getKeyIsDown(${this.descendInput(node.key).asSafe()})`, ValueType.BOOLEAN);

        case InputOpcode.LIST_CONTAINS:
            return new TypedInput(`listContains(${this.referenceVariable(node.list)}, ${this.descendInput(node.item).asUnknown()})`, ValueType.BOOLEAN);
        case InputOpcode.LIST_CONTENTS:
            return new TypedInput(`listContents(${this.referenceVariable(node.list)})`, ValueType.STRING);
        case InputOpcode.LIST_GET: {
            const index = this.descendInput(node.index);
            if (environment.supportsNullishCoalescing) {
                if (index.isAlwaysNumberOrNaN()) {
                    return new TypedInput(`(${this.referenceVariable(node.list)}.value[(${index.asNumber()} | 0) - 1] ?? "")`, ValueType.UNKNOWN);
                }
                if (index instanceof ConstantInput && index.constantValue === 'last') {
                    return new TypedInput(`(${this.referenceVariable(node.list)}.value[${this.referenceVariable(node.list)}.value.length - 1] ?? "")`, ValueType.UNKNOWN);
                }
            }
            return new TypedInput(`listGet(${this.referenceVariable(node.list)}.value, ${index.asUnknown()})`, ValueType.UNKNOWN);
        }
        case InputOpcode.LIST_INDEX_OF:
            return new TypedInput(`listIndexOf(${this.referenceVariable(node.list)}, ${this.descendInput(node.item).asUnknown()})`, ValueType.NUMBER);
        case InputOpcode.LIST_LENGTH:
            return new TypedInput(`${this.referenceVariable(node.list)}.value.length`, ValueType.NUMBER);

        case InputOpcode.LOOKS_SIZE_GET:
            return new TypedInput('Math.round(target.size)', ValueType.NUMBER);
        case InputOpcode.LOOKS_BACKDROP_NAME:
            return new TypedInput('stage.getCostumes()[stage.currentCostume].name', ValueType.STRING);
        case InputOpcode.LOOKS_BACKDROP_NUMBER:
            return new TypedInput('(stage.currentCostume + 1)', ValueType.NUMBER);
        case InputOpcode.LOOKS_COSTUME_NAME:
            return new TypedInput('target.getCostumes()[target.currentCostume].name', ValueType.STRING);
        case InputOpcode.LOOKS_COSTUME_NUMBER:
            return new TypedInput('(target.currentCostume + 1)', ValueType.NUMBER);

        case InputOpcode.MOTION_DIRECTION_GET:
            return new TypedInput('target.direction', ValueType.NUMBER);
        case InputOpcode.MOTION_X_GET:
            return new TypedInput('limitPrecision(target.x)', ValueType.NUMBER);
        case InputOpcode.MOTION_Y_GET:
            return new TypedInput('limitPrecision(target.y)', ValueType.NUMBER);

        case InputOpcode.SENSING_MOUSE_DOWN:
            return new TypedInput('runtime.ioDevices.mouse.getIsDown()', ValueType.BOOLEAN);
        case InputOpcode.SENSING_MOUSE_X:
            return new TypedInput('runtime.ioDevices.mouse.getScratchX()', ValueType.NUMBER);
        case InputOpcode.SENSING_MOUSE_Y:
            return new TypedInput('runtime.ioDevices.mouse.getScratchY()', ValueType.NUMBER);

        case InputOpcode.OP_ABS:
            return new TypedInput(`Math.abs(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_ACOS:
            // Needs to be marked as NaN because Math.acos(1.0001) === NaN
            return new TypedInput(`((Math.acos(${this.descendInput(node.value).asNumber()}) * 180) / Math.PI)`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_ADD:
            // Needs to be marked as NaN because Infinity + -Infinity === NaN
            return new TypedInput(`(${this.descendInput(node.left).asNumber()} + ${this.descendInput(node.right).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_AND:
            return new TypedInput(`(${this.descendInput(node.left).asBoolean()} && ${this.descendInput(node.right).asBoolean()})`, ValueType.BOOLEAN);
        case InputOpcode.OP_ASIN:
            // Needs to be marked as NaN because Math.asin(1.0001) === NaN
            return new TypedInput(`((Math.asin(${this.descendInput(node.value).asNumber()}) * 180) / Math.PI)`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_ATAN:
            return new TypedInput(`((Math.atan(${this.descendInput(node.value).asNumber()}) * 180) / Math.PI)`, ValueType.NUMBER);
        case InputOpcode.OP_CEILING:
            return new TypedInput(`Math.ceil(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_CONTAINS:
            return new TypedInput(`(${this.descendInput(node.string).asString()}.toLowerCase().indexOf(${this.descendInput(node.contains).asString()}.toLowerCase()) !== -1)`, ValueType.BOOLEAN);
        case InputOpcode.OP_COS:
            return new TypedInput(`(Math.round(Math.cos((Math.PI * ${this.descendInput(node.value).asNumber()}) / 180) * 1e10) / 1e10)`, ValueType.NUMBER);
        case InputOpcode.OP_DIVIDE:
            // Needs to be marked as NaN because 0 / 0 === NaN
            return new TypedInput(`(${this.descendInput(node.left).asNumber()} / ${this.descendInput(node.right).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_EQUALS: {
            const left = this.descendInput(node.left);
            const right = this.descendInput(node.right);
            // When both operands are known to never be numbers, only use string comparison to avoid all number parsing.
            if (left.isNeverNumber() || right.isNeverNumber()) {
                return new TypedInput(`(${left.asString()}.toLowerCase() === ${right.asString()}.toLowerCase())`, ValueType.BOOLEAN);
            }
            const leftAlwaysNumber = left.isAlwaysNumber();
            const rightAlwaysNumber = right.isAlwaysNumber();
            // When both operands are known to be numbers, we can use ===
            if (leftAlwaysNumber && rightAlwaysNumber) {
                return new TypedInput(`(${left.asNumber()} === ${right.asNumber()})`, ValueType.BOOLEAN);
            }
            // In certain conditions, we can use === when one of the operands is known to be a safe number.
            if (leftAlwaysNumber && left instanceof ConstantInput && isSafeConstantForEqualsOptimization(left)) {
                return new TypedInput(`(${left.asNumber()} === ${right.asNumber()})`, ValueType.BOOLEAN);
            }
            if (rightAlwaysNumber && right instanceof ConstantInput && isSafeConstantForEqualsOptimization(right)) {
                return new TypedInput(`(${left.asNumber()} === ${right.asNumber()})`, ValueType.BOOLEAN);
            }
            // No compile-time optimizations possible - use fallback method.
            return new TypedInput(`compareEqual(${left.asUnknown()}, ${right.asUnknown()})`, ValueType.BOOLEAN);
        }
        case InputOpcode.OP_POW_E:
            return new TypedInput(`Math.exp(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_FLOOR:
            return new TypedInput(`Math.floor(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_GREATER: {
            const left = this.descendInput(node.left);
            const right = this.descendInput(node.right);
            // When the left operand is a number and the right operand is a number or NaN, we can use >
            if (left.isAlwaysNumber() && right.isAlwaysNumberOrNaN()) {
                return new TypedInput(`(${left.asNumber()} > ${right.asNumberOrNaN()})`, ValueType.BOOLEAN);
            }
            // When the left operand is a number or NaN and the right operand is a number, we can negate <=
            if (left.isAlwaysNumberOrNaN() && right.isAlwaysNumber()) {
                return new TypedInput(`!(${left.asNumberOrNaN()} <= ${right.asNumber()})`, ValueType.BOOLEAN);
            }
            // When either operand is known to never be a number, avoid all number parsing.
            if (left.isNeverNumber() || right.isNeverNumber()) {
                return new TypedInput(`(${left.asString()}.toLowerCase() > ${right.asString()}.toLowerCase())`, ValueType.BOOLEAN);
            }
            // No compile-time optimizations possible - use fallback method.
            return new TypedInput(`compareGreaterThan(${left.asUnknown()}, ${right.asUnknown()})`, ValueType.BOOLEAN);
        }
        case InputOpcode.OP_JOIN:
            return new TypedInput(`(${this.descendInput(node.left).asString()} + ${this.descendInput(node.right).asString()})`, ValueType.STRING);
        case InputOpcode.OP_LENGTH:
            return new TypedInput(`${this.descendInput(node.string).asString()}.length`, ValueType.NUMBER);
        case InputOpcode.OP_LESS: {
            const left = this.descendInput(node.left);
            const right = this.descendInput(node.right);
            // When the left operand is a number or NaN and the right operand is a number, we can use <
            if (left.isAlwaysNumberOrNaN() && right.isAlwaysNumber()) {
                return new TypedInput(`(${left.asNumberOrNaN()} < ${right.asNumber()})`, ValueType.BOOLEAN);
            }
            // When the left operand is a number and the right operand is a number or NaN, we can negate >=
            if (left.isAlwaysNumber() && right.isAlwaysNumberOrNaN()) {
                return new TypedInput(`!(${left.asNumber()} >= ${right.asNumberOrNaN()})`, ValueType.BOOLEAN);
            }
            // When either operand is known to never be a number, avoid all number parsing.
            if (left.isNeverNumber() || right.isNeverNumber()) {
                return new TypedInput(`(${left.asString()}.toLowerCase() < ${right.asString()}.toLowerCase())`, ValueType.BOOLEAN);
            }
            // No compile-time optimizations possible - use fallback method.
            return new TypedInput(`compareLessThan(${left.asUnknown()}, ${right.asUnknown()})`, ValueType.BOOLEAN);
        }
        case InputOpcode.OP_LETTER_OF:
            return new TypedInput(`((${this.descendInput(node.string).asString()})[(${this.descendInput(node.letter).asNumber()} | 0) - 1] || "")`, ValueType.STRING);
        case InputOpcode.OP_LOG_E:
            // Needs to be marked as NaN because Math.log(-1) == NaN
            return new TypedInput(`Math.log(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_LOG_10:
            // Needs to be marked as NaN because Math.log(-1) == NaN
            return new TypedInput(`(Math.log(${this.descendInput(node.value).asNumber()}) / Math.LN10)`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_MOD:
            this.descendedIntoModulo = true;
            // Needs to be marked as NaN because mod(0, 0) (and others) == NaN
            return new TypedInput(`mod(${this.descendInput(node.left).asNumber()}, ${this.descendInput(node.right).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_MULTIPLY:
            // Needs to be marked as NaN because Infinity * 0 === NaN
            return new TypedInput(`(${this.descendInput(node.left).asNumber()} * ${this.descendInput(node.right).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_NOT:
            return new TypedInput(`!${this.descendInput(node.operand).asBoolean()}`, ValueType.BOOLEAN);
        case InputOpcode.OP_OR:
            return new TypedInput(`(${this.descendInput(node.left).asBoolean()} || ${this.descendInput(node.right).asBoolean()})`, ValueType.BOOLEAN);
        case InputOpcode.OP_RANDOM:
            if (node.useInts) {
                return new TypedInput(`randomInt(${this.descendInput(node.low).asNumber()}, ${this.descendInput(node.high).asNumber()})`, ValueType.NUMBER);
            }
            if (node.useFloats) {
                return new TypedInput(`randomFloat(${this.descendInput(node.low).asNumber()}, ${this.descendInput(node.high).asNumber()})`, ValueType.NUMBER);
            }
            return new TypedInput(`runtime.ext_scratch3_operators._random(${this.descendInput(node.low).asUnknown()}, ${this.descendInput(node.high).asUnknown()})`, ValueType.NUMBER);
        case InputOpcode.OP_ROUND:
            return new TypedInput(`Math.round(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_SIN:
            return new TypedInput(`(Math.round(Math.sin((Math.PI * ${this.descendInput(node.value).asNumber()}) / 180) * 1e10) / 1e10)`, ValueType.NUMBER);
        case InputOpcode.OP_SQRT:
            // Needs to be marked as NaN because Math.sqrt(-1) === NaN
            return new TypedInput(`Math.sqrt(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_SUBTRACT:
            // Needs to be marked as NaN because Infinity - Infinity === NaN
            return new TypedInput(`(${this.descendInput(node.left).asNumber()} - ${this.descendInput(node.right).asNumber()})`, ValueType.NUMBER_OR_NAN);
        case InputOpcode.OP_TAN:
            return new TypedInput(`tan(${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);
        case InputOpcode.OP_POW_10:
            return new TypedInput(`(10 ** ${this.descendInput(node.value).asNumber()})`, ValueType.NUMBER);

        case InputOpcode.SENSING_ANSWER:
            return new TypedInput(`runtime.ext_scratch3_sensing._answer`, ValueType.STRING);
        case InputOpcode.SENSING_COLOR_TOUCHING_COLOR:
            return new TypedInput(`target.colorIsTouchingColor(colorToList(${this.descendInput(node.target).asColor()}), colorToList(${this.descendInput(node.mask).asColor()}))`, ValueType.BOOLEAN);
        case InputOpcode.SENSING_TIME_DATE:
            return new TypedInput(`(new Date().getDate())`, ValueType.NUMBER);
        case InputOpcode.SENSING_TIME_WEEKDAY:
            return new TypedInput(`(new Date().getDay() + 1)`, ValueType.NUMBER);
        case InputOpcode.SENSING_TIME_DAYS_SINCE_2000:
            return new TypedInput('daysSince2000()', ValueType.NUMBER);
        case InputOpcode.SENSING_DISTANCE:
            // TODO: on stages, this can be computed at compile time
            return new TypedInput(`distance(${this.descendInput(node.target).asString()})`, ValueType.NUMBER);
        case InputOpcode.SENSING_TIME_HOUR:
            return new TypedInput(`(new Date().getHours())`, ValueType.NUMBER);
        case InputOpcode.SENSING_TIME_MINUTE:
            return new TypedInput(`(new Date().getMinutes())`, ValueType.NUMBER);
        case InputOpcode.SENSING_TIME_MONTH:
            return new TypedInput(`(new Date().getMonth() + 1)`, ValueType.NUMBER);
        case InputOpcode.SENSING_OF: {
            const object = this.descendInput(node.object).asString();
            const property = node.property;
            if (node.object.opcode === InputOpcode.CONSTANT) {
                const isStage = node.object.inputs.value === '_stage_';
                // Note that if target isn't a stage, we can't assume it exists
                const objectReference = isStage ? 'stage' : this.evaluateOnce(`runtime.getSpriteTargetByName(${object})`);
                if (property === 'volume') {
                    return new TypedInput(`(${objectReference} ? ${objectReference}.volume : 0)`, ValueType.NUMBER);
                }
                if (isStage) {
                    switch (property) {
                    case 'background #':
                        // fallthrough for scratch 1.0 compatibility
                    case 'backdrop #':
                        return new TypedInput(`(${objectReference}.currentCostume + 1)`, ValueType.NUMBER);
                    case 'backdrop name':
                        return new TypedInput(`${objectReference}.getCostumes()[${objectReference}.currentCostume].name`, ValueType.STRING);
                    }
                } else {
                    switch (property) {
                    case 'x position':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.x : 0)`, ValueType.NUMBER);
                    case 'y position':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.y : 0)`, ValueType.NUMBER);
                    case 'direction':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.direction : 0)`, ValueType.NUMBER);
                    case 'costume #':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.currentCostume + 1 : 0)`, ValueType.NUMBER);
                    case 'costume name':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.getCostumes()[${objectReference}.currentCostume].name : 0)`, ValueType.UNKNOWN);
                    case 'size':
                        return new TypedInput(`(${objectReference} ? ${objectReference}.size : 0)`, ValueType.NUMBER);
                    }
                }
                const variableReference = this.evaluateOnce(`${objectReference} && ${objectReference}.lookupVariableByNameAndType("${sanitize(property)}", "", true)`);
                return new TypedInput(`(${variableReference} ? ${variableReference}.value : 0)`, ValueType.UNKNOWN);
            }
            return new TypedInput(`runtime.ext_scratch3_sensing.getAttributeOf({OBJECT: ${object}, PROPERTY: "${sanitize(property)}" })`, ValueType.UNKNOWN);
        }
        case InputOpcode.SENSING_TIME_SECOND:
            return new TypedInput(`(new Date().getSeconds())`, ValueType.NUMBER);
        case InputOpcode.SENSING_TOUCHING_OBJECT:
            return new TypedInput(`target.isTouchingObject(${this.descendInput(node.object).asUnknown()})`, ValueType.BOOLEAN);
        case InputOpcode.SENSING_TOUCHING_COLOR:
            return new TypedInput(`target.isTouchingColor(colorToList(${this.descendInput(node.color).asColor()}))`, ValueType.BOOLEAN);
        case InputOpcode.SENSING_USERNAME:
            return new TypedInput('runtime.ioDevices.userData.getUsername()', ValueType.STRING);
        case InputOpcode.SENSING_TIME_YEAR:
            return new TypedInput(`(new Date().getFullYear())`, ValueType.NUMBER);

        case InputOpcode.SENSING_TIMER_GET:
            return new TypedInput('runtime.ioDevices.clock.projectTimer()', ValueType.NUMBER);

        case InputOpcode.TW_KEY_LAST_PRESSED:
            return new TypedInput('runtime.ioDevices.keyboard.getLastKeyPressed()', ValueType.STRING);

        case InputOpcode.VAR_GET:
            return this.descendVariable(node.variable);

        default:
            log.warn(`JS: Unknown input: ${block.opcode}`, node);
            throw new Error(`JS: Unknown input: ${block.opcode}`);
        }
    }

    /**
     * @param {IntermediateStack} block Stacked block to compile.
     */
    descendStackedBlock (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case StackOpcode.ADDON_CALL: {
            const inputs = this.descendInputRecord(node.arguments);
            const blockFunction = `runtime.getAddonBlock("${sanitize(node.code)}").callback`;
            const blockId = `"${sanitize(node.blockId)}"`;
            this.source += `yield* executeInCompatibilityLayer(${inputs}, ${blockFunction}, ${this.isWarp}, false, ${blockId});\n`;
            break;
        }

        case StackOpcode.COMPATIBILITY_LAYER: {
            // If the last command in a loop returns a promise, immediately continue to the next iteration.
            // If you don't do this, the loop effectively yields twice per iteration and will run at half-speed.
            const isLastInLoop = this.isLastBlockInLoop();
            this.source += `${this.generateCompatibilityLayerCall(block, isLastInLoop)};\n`;
            if (isLastInLoop) {
                this.source += 'if (hasResumedFromPromise) {hasResumedFromPromise = false;continue;}\n';
            }
            break;
        }

        case StackOpcode.CONTROL_CLONE_CREATE:
            this.source += `runtime.ext_scratch3_control._createClone(${this.descendInput(node.target).asString()}, target);\n`;
            break;
        case StackOpcode.CONTROL_CLONE_DELETE:
            this.source += 'if (!target.isOriginal) {\n';
            this.source += '  runtime.disposeTarget(target);\n';
            this.source += '  runtime.stopForTarget(target);\n';
            this.retire();
            this.source += '}\n';
            break;
        case StackOpcode.CONTROL_FOR: {
            this.resetVariableInputs();
            const index = this.localVariables.next();
            this.source += `var ${index} = 0; `;
            this.source += `while (${index} < ${this.descendInput(node.count).asNumber()}) { `;
            this.source += `${index}++; `;
            this.source += `${this.referenceVariable(node.variable)}.value = ${index};\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += '}\n';
            break;
        }
        case StackOpcode.CONTROL_IF_ELSE:
            this.source += `if (${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.descendStack(node.whenTrue, new Frame(false));
            // only add the else branch if it won't be empty
            // this makes scripts have a bit less useless noise in them
            if (node.whenFalse.length) {
                this.source += `} else {\n`;
                this.descendStack(node.whenFalse, new Frame(false));
            }
            this.source += `}\n`;
            break;
        case StackOpcode.CONTROL_REPEAT: {
            const i = this.localVariables.next();
            this.source += `for (var ${i} = ${this.descendInput(node.times).asNumber()}; ${i} >= 0.5; ${i}--) {\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += `}\n`;
            break;
        }
        case StackOpcode.CONTROL_STOP_ALL:
            this.source += 'runtime.stopAll();\n';
            this.retire();
            break;
        case StackOpcode.CONTROL_STOP_OTHERS:
            this.source += 'runtime.stopForTarget(target, thread);\n';
            break;
        case StackOpcode.CONTROL_STOP_SCRIPT:
            if (this.isProcedure) {
                this.source += 'return;\n';
            } else {
                this.retire();
            }
            break;
        case StackOpcode.CONTROL_WAIT: {
            const duration = this.localVariables.next();
            this.source += `thread.timer = timer();\n`;
            this.source += `var ${duration} = Math.max(0, 1000 * ${this.descendInput(node.seconds).asNumber()});\n`;
            this.requestRedraw();
            // always yield at least once, even on 0 second durations
            this.yieldNotWarp();
            this.source += `while (thread.timer.timeElapsed() < ${duration}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += '}\n';
            this.source += 'thread.timer = null;\n';
            break;
        }
        case StackOpcode.CONTROL_WAIT_UNTIL: {
            this.resetVariableInputs();
            this.source += `while (!${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += `}\n`;
            break;
        }
        case StackOpcode.CONTROL_WHILE:
            this.resetVariableInputs();
            this.source += `while (${this.descendInput(node.condition).asBoolean()}) {\n`;
            this.descendStack(node.do, new Frame(true));
            if (node.warpTimer) {
                this.yieldStuckOrNotWarp();
            } else {
                this.yieldLoop();
            }
            this.source += `}\n`;
            break;

        case StackOpcode.EVENT_BROADCAST:
            this.source += `startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast).asString()} });\n`;
            this.resetVariableInputs();
            break;
        case StackOpcode.EVENT_BROADCAST_AND_WAIT:
            this.source += `yield* waitThreads(startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast).asString()} }));\n`;
            this.yielded();
            break;

        case StackOpcode.LIST_ADD: {
            const list = this.referenceVariable(node.list);
            this.source += `${list}.value.push(${this.descendInput(node.item).asSafe()});\n`;
            this.source += `${list}._monitorUpToDate = false;\n`;
            break;
        }
        case StackOpcode.LIST_DELETE: {
            const list = this.referenceVariable(node.list);
            const index = this.descendInput(node.index);
            if (index instanceof ConstantInput) {
                if (index.constantValue === 'last') {
                    this.source += `${list}.value.pop();\n`;
                    this.source += `${list}._monitorUpToDate = false;\n`;
                    break;
                }
                if (+index.constantValue === 1) {
                    this.source += `${list}.value.shift();\n`;
                    this.source += `${list}._monitorUpToDate = false;\n`;
                    break;
                }
                // do not need a special case for all as that is handled in IR generation (list.deleteAll)
            }
            this.source += `listDelete(${list}, ${index.asUnknown()});\n`;
            break;
        }
        case StackOpcode.LIST_DELETE_ALL:
            this.source += `${this.referenceVariable(node.list)}.value = [];\n`;
            break;
        case StackOpcode.LIST_HIDE:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.LIST_INSERT: {
            const list = this.referenceVariable(node.list);
            const index = this.descendInput(node.index);
            const item = this.descendInput(node.item);
            if (index instanceof ConstantInput && +index.constantValue === 1) {
                this.source += `${list}.value.unshift(${item.asSafe()});\n`;
                this.source += `${list}._monitorUpToDate = false;\n`;
                break;
            }
            this.source += `listInsert(${list}, ${index.asUnknown()}, ${item.asSafe()});\n`;
            break;
        }
        case StackOpcode.LIST_REPLACE:
            this.source += `listReplace(${this.referenceVariable(node.list)}, ${this.descendInput(node.index).asUnknown()}, ${this.descendInput(node.item).asSafe()});\n`;
            break;
        case StackOpcode.LIST_SHOW:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case StackOpcode.LOOKS_LAYER_BACKWARD:
            if (!this.target.isStage) {
                this.source += `target.goBackwardLayers(${this.descendInput(node.layers).asNumber()});\n`;
            }
            break;
        case StackOpcode.LOOKS_EFFECT_CLEAR:
            this.source += 'target.clearEffects();\n';
            break;
        case StackOpcode.LOOKS_EFFECT_CHANGE:
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value).asNumber()} + target.effects["${sanitize(node.effect)}"]));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_CHANGE:
            this.source += `target.setSize(target.size + ${this.descendInput(node.size).asNumber()});\n`;
            break;
        case StackOpcode.LOOKS_LAYER_FORWARD:
            if (!this.target.isStage) {
                this.source += `target.goForwardLayers(${this.descendInput(node.layers).asNumber()});\n`;
            }
            break;
        case StackOpcode.LOOKS_LAYER_BACK:
            if (!this.target.isStage) {
                this.source += 'target.goToBack();\n';
            }
            break;
        case StackOpcode.LOOKS_LAYER_FRONT:
            if (!this.target.isStage) {
                this.source += 'target.goToFront();\n';
            }
            break;
        case StackOpcode.LOOKS_HIDE:
            this.source += 'target.setVisible(false);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_NEXT:
            this.source += 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true);\n';
            break;
        case StackOpcode.LOOKS_COSTUME_NEXT:
            this.source += 'target.setCostume(target.currentCostume + 1);\n';
            break;
        case StackOpcode.LOOKS_EFFECT_SET:
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value).asNumber()}));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_SET:
            this.source += `target.setSize(${this.descendInput(node.size).asNumber()});\n`;
            break;
        case StackOpcode.LOOKS_SHOW:
            this.source += 'target.setVisible(true);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_SET:
            this.source += `runtime.ext_scratch3_looks._setBackdrop(stage, ${this.descendInput(node.backdrop).asSafe()});\n`;
            break;
        case StackOpcode.LOOKS_COSTUME_SET:
            this.source += `runtime.ext_scratch3_looks._setCostume(target, ${this.descendInput(node.costume).asSafe()});\n`;
            break;

        case StackOpcode.MOTION_X_CHANGE:
            this.source += `target.setXY(target.x + ${this.descendInput(node.dx).asNumber()}, target.y);\n`;
            break;
        case StackOpcode.MOTION_Y_CHANGE:
            this.source += `target.setXY(target.x, target.y + ${this.descendInput(node.dy).asNumber()});\n`;
            break;
        case StackOpcode.MOTION_IF_ON_EDGE_BOUNCE:
            this.source += `runtime.ext_scratch3_motion._ifOnEdgeBounce(target);\n`;
            break;
        case StackOpcode.MOTION_DIRECTION_SET:
            this.source += `target.setDirection(${this.descendInput(node.direction).asNumber()});\n`;
            break;
        case StackOpcode.MOTION_ROTATION_STYLE_SET:
            this.source += `target.setRotationStyle("${sanitize(node.style)}");\n`;
            break;
        case StackOpcode.MOTION_X_SET: // fallthrough
        case StackOpcode.MOTION_Y_SET: // fallthrough
        case StackOpcode.MOTION_XY_SET: {
            this.descendedIntoModulo = false;
            const x = 'x' in node ? this.descendInput(node.x).asNumber() : 'target.x';
            const y = 'y' in node ? this.descendInput(node.y).asNumber() : 'target.y';
            this.source += `target.setXY(${x}, ${y});\n`;
            if (this.descendedIntoModulo) {
                this.source += `if (target.interpolationData) target.interpolationData = null;\n`;
            }
            break;
        }
        case StackOpcode.MOTION_STEP:
            this.source += `runtime.ext_scratch3_motion._moveSteps(${this.descendInput(node.steps).asNumber()}, target);\n`;
            break;

        case StackOpcode.NOP:
            // todo: remove noop entirely
            break;

        case StackOpcode.PEN_CLEAR:
            this.source += `${PEN_EXT}.clear();\n`;
            break;
        case StackOpcode.PEN_DOWN:
            this.source += `${PEN_EXT}._penDown(target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_CHANGE:
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param).asString()}, ${this.descendInput(node.value).asNumber()}, ${PEN_STATE}, true);\n`;
            break;
        case StackOpcode.PEN_SIZE_CHANGE:
            this.source += `${PEN_EXT}._changePenSizeBy(${this.descendInput(node.size).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY:
            this.source += `${PEN_EXT}._changePenHueBy(${this.descendInput(node.hue).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SHADE_CHANGE_LEGACY:
            this.source += `${PEN_EXT}._changePenShadeBy(${this.descendInput(node.shade).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_SET_LEGACY:
            this.source += `${PEN_EXT}._setPenHueToNumber(${this.descendInput(node.hue).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY:
            this.source += `${PEN_EXT}._setPenShadeToNumber(${this.descendInput(node.shade).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SET:
            this.source += `${PEN_EXT}._setPenColorToColor(${this.descendInput(node.color).asColor()}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_SET:
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param).asString()}, ${this.descendInput(node.value).asNumber()}, ${PEN_STATE}, false);\n`;
            break;
        case StackOpcode.PEN_SIZE_SET:
            this.source += `${PEN_EXT}._setPenSizeTo(${this.descendInput(node.size).asNumber()}, target);\n`;
            break;
        case StackOpcode.PEN_STAMP:
            this.source += `${PEN_EXT}._stamp(target);\n`;
            break;
        case StackOpcode.PEN_UP:
            this.source += `${PEN_EXT}._penUp(target);\n`;
            break;

        case StackOpcode.PROCEDURE_CALL: {
            const procedureCode = node.code;
            const procedureVariant = node.variant;
            const procedureData = this.ir.procedures[procedureVariant];
            if (procedureData.stack === null) {
                // TODO still need to evaluate arguments
                break;
            }

            const yieldForRecursion = !this.isWarp && procedureCode === this.script.procedureCode;
            if (yieldForRecursion) {
                this.yieldNotWarp();
            }

            if (procedureData.yields) {
                this.source += 'yield* ';
            }
            this.source += `thread.procedures["${sanitize(procedureVariant)}"](`;
            const args = [];
            for (const input of node.arguments) {
                args.push(this.descendInput(input).asSafe());
            }
            this.source += args.join(',');
            this.source += ');\n';

            this.resetVariableInputs();
            break;
        }
        case 'procedures.return':
            this.stopScriptAndReturn(this.descendInput(node.value).asSafe());
            break;

        case StackOpcode.SENSING_TIMER_RESET:
            this.source += 'runtime.ioDevices.clock.resetProjectTimer();\n';
            break;

        case StackOpcode.DEBUGGER:
            this.source += 'debugger;\n';
            break;

        case StackOpcode.VAR_HIDE:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.VAR_SET: {
            const variable = this.descendVariable(node.variable);
            const value = this.descendInput(node.value);
            variable.setInput(value);
            this.source += `${variable.source} = ${value.asSafe()};\n`;
            if (node.variable.isCloud) {
                this.source += `runtime.ioDevices.cloud.requestUpdateVariable("${sanitize(node.variable.name)}", ${variable.source});\n`;
            }
            break;
        }
        case StackOpcode.VAR_SHOW:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case StackOpcode.VISUAL_REPORT: {
            const value = this.localVariables.next();
            this.source += `const ${value} = ${this.descendInput(node.input).asUnknown()};`;
            // blocks like legacy no-ops can return a literal `undefined`
            this.source += `if (${value} !== undefined) runtime.visualReport("${sanitize(this.script.topBlockId)}", ${value});\n`;
            break;
        }

        default:
            log.warn(`JS: Unknown stacked block: ${block.opcode}`, node);
            throw new Error(`JS: Unknown stacked block: ${block.opcode}`);
        }
    }

    /**
     * Compile a Record of input objects into a safe JS string.
     * @param {Record<string, unknown>} inputs
     * @returns {string}
     */
    descendInputRecord (inputs) {
        let result = '{';
        for (const name of Object.keys(inputs)) {
            const node = inputs[name];
            result += `"${sanitize(name)}":${this.descendInput(node).asSafe()},`;
        }
        result += '}';
        return result;
    }

    resetVariableInputs () {
        this.variableInputs = {};
    }

    descendStack (nodes, frame) {
        // Entering a stack -- all bets are off.
        // TODO: allow if/else to inherit values
        this.resetVariableInputs();
        this.pushFrame(frame);

        for (let i = 0; i < nodes.length; i++) {
            frame.isLastBlock = i === nodes.length - 1;
            this.descendStackedBlock(nodes[i]);
        }

        // Leaving a stack -- any assumptions made in the current stack do not apply outside of it
        // TODO: in if/else this might create an extra unused object
        this.resetVariableInputs();
        this.popFrame();
    }

    descendVariable (variable) {
        if (Object.prototype.hasOwnProperty.call(this.variableInputs, variable.id)) {
            return this.variableInputs[variable.id];
        }
        const input = new VariableInput(`${this.referenceVariable(variable)}.value`);
        this.variableInputs[variable.id] = input;
        return input;
    }

    referenceVariable (variable) {
        if (variable.scope === 'target') {
            return this.evaluateOnce(`target.variables["${sanitize(variable.id)}"]`);
        }
        return this.evaluateOnce(`stage.variables["${sanitize(variable.id)}"]`);
    }

    descendAddonCall (node) {
        const inputs = this.descendInputRecord(node.arguments);
        const blockFunction = `runtime.getAddonBlock("${sanitize(node.code)}").callback`;
        const blockId = `"${sanitize(node.blockId)}"`;
        return `yield* executeInCompatibilityLayer(${inputs}, ${blockFunction}, ${this.isWarp}, false, ${blockId})`;
    }

    evaluateOnce (source) {
        if (Object.prototype.hasOwnProperty.call(this._setupVariables, source)) {
            return this._setupVariables[source];
        }
        const variable = this._setupVariablesPool.next();
        this._setupVariables[source] = variable;
        return variable;
    }

    retire () {
        // After running retire() (sets thread status and cleans up some unused data), we need to return to the event loop.
        // When in a procedure, return will only send us back to the previous procedure, so instead we yield back to the sequencer.
        // Outside of a procedure, return will correctly bring us back to the sequencer.
        if (this.isProcedure) {
            this.source += 'retire(); yield;\n';
        } else {
            this.source += 'retire(); return;\n';
        }
    }

    stopScript () {
        if (this.isProcedure) {
            this.source += 'return "";\n';
        } else {
            this.retire();
        }
    }

    /**
     * @param {string} valueJS JS code of value to return.
     */
    stopScriptAndReturn (valueJS) {
        if (this.isProcedure) {
            this.source += `return ${valueJS};\n`;
        } else {
            this.retire();
        }
    }

    yieldLoop () {
        if (this.warpTimer) {
            this.yieldStuckOrNotWarp();
        } else {
            this.yieldNotWarp();
        }
    }

    /**
     * Write JS to yield the current thread if warp mode is disabled.
     */
    yieldNotWarp () {
        if (!this.isWarp) {
            this.source += 'yield;\n';
            this.yielded();
        }
    }

    /**
     * Write JS to yield the current thread if warp mode is disabled or if the script seems to be stuck.
     */
    yieldStuckOrNotWarp () {
        if (this.isWarp) {
            this.source += 'if (isStuck()) yield;\n';
        } else {
            this.source += 'yield;\n';
        }
        this.yielded();
    }

    yielded () {
        if (!this.script.yields) {
            throw new Error('Script yielded but is not marked as yielding.');
        }
        // Control may have been yielded to another script -- all bets are off.
        this.resetVariableInputs();
    }

    /**
     * Write JS to request a redraw.
     */
    requestRedraw () {
        this.source += 'runtime.requestRedraw();\n';
    }

    safeConstantInput (value) {
        const unsafe = typeof value === 'string' && this.namesOfCostumesAndSounds.has(value);
        return new ConstantInput(value, !unsafe);
    }

    /**
     * Generate a call into the compatibility layer.
     * @param {IntermediateStack} block The block to generate from.
     * @param {boolean} setFlags Whether flags should be set describing how this function was processed.
     * @param {string|null} [frameName] Name of the stack frame variable, if any
     * @returns {string} The JS of the call.
     */
    generateCompatibilityLayerCall (block, setFlags) {
        const node = block.inputs;
        const opcode = node.opcode;

        let result = 'yield* executeInCompatibilityLayer({';

        for (const inputName of Object.keys(node.inputs)) {
            const input = node.inputs[inputName];
            const compiledInput = this.descendInput(input).asSafe();
            result += `"${sanitize(inputName)}":${compiledInput},`;
        }
        for (const fieldName of Object.keys(node.fields)) {
            const field = node.fields[fieldName];
            result += `"${sanitize(fieldName)}":"${sanitize(field)}",`;
        }
        const opcodeFunction = this.evaluateOnce(`runtime.getOpcodeFunction("${sanitize(opcode)}")`);
        result += `}, ${opcodeFunction}, ${this.isWarp}, ${setFlags}, "${sanitize(node.id)}", ${frameName})`;

        return result;
    }

    getScriptFactoryName () {
        return factoryNameVariablePool.next();
    }

    getScriptName (yields) {
        let name = yields ? generatorNameVariablePool.next() : functionNameVariablePool.next();
        if (this.isProcedure) {
            const simplifiedProcedureCode = this.script.procedureCode
                .replace(/%[\w]/g, '') // remove arguments
                .replace(/[^a-zA-Z0-9]/g, '_') // remove unsafe
                .substring(0, 20); // keep length reasonable
            name += `_${simplifiedProcedureCode}`;
        }
        return name;
    }

    /**
     * Generate the JS to pass into eval() based on the current state of the compiler.
     * @returns {string} JS to pass into eval()
     */
    createScriptFactory () {
        let script = '';

        // Setup the factory
        script += `(function ${this.getScriptFactoryName()}(thread) { `;
        script += 'const target = thread.target; ';
        script += 'const runtime = target.runtime; ';
        script += 'const stage = runtime.getTargetForStage();\n';
        for (const varValue of Object.keys(this._setupVariables)) {
            const varName = this._setupVariables[varValue];
            script += `const ${varName} = ${varValue};\n`;
        }

        // Generated script
        script += 'return ';
        if (this.script.yields) {
            script += `function* `;
        } else {
            script += `function `;
        }
        script += this.getScriptName(this.script.yields);
        script += ' (';
        if (this.script.arguments.length) {
            const args = [];
            for (let i = 0; i < this.script.arguments.length; i++) {
                args.push(`p${i}`);
            }
            script += args.join(',');
        }
        script += ') {\n';

        script += this.source;

        script += '}; })';

        return script;
    }

    /**
     * Compile this script.
     * @returns {Function} The factory function for the script.
     */
    compile () {
        if (this.script.stack) {
            this.descendStack(this.script.stack, new Frame(false));
        }
        this.stopScript();

        const factory = this.createScriptFactory();
        const fn = jsexecute.scopedEval(factory);

        if (this.debug) {
            log.info(`JS: ${this.target.getName()}: compiled ${this.script.procedureCode || 'script'}`, factory);
        }

        if (JSGenerator.testingApparatus) {
            JSGenerator.testingApparatus.report(this, factory);
        }

        return fn;
    }
}

// Test hook used by automated snapshot testing.
JSGenerator.testingApparatus = null;

module.exports = JSGenerator;
