const Cast = require('../util/cast');
const { InputOpcode, InputType } = require('./enums.js')

/**
 * @fileoverview Common intermediates shared amongst parts of the compiler.
 */

/**
 * Describes a 'stackable' block (eg. show)
 */
class IntermediateStack {
    /**
     * @param {import("./enums").StackOpcode} opcode 
     * @param {Object} inputs 
     */
    constructor(opcode, inputs = {}) {
        /**
         * The type of the stackable block.
         * @type {import("./enums").StackOpcode}
         */
        this.opcode = opcode;

        /**
         * The 
         * @type {Object} 
         */
        this.inputs = inputs;
    }
}

/**
 * Describes an input to a block.
 * This could be a constant, variable or math operation.
 */
class IntermediateInput {

    static getNumberInputType(number) {
        if (number < 0) return InputType.NUMBER_NEG;
        if (number > 0) return InputType.NUMBER_POS;
        return InputType.NUMBER_ZERO;
    }

    /**
     * @param {InputOpcode} opcode 
     * @param {InputType} type
     * @param {Object} inputs 
     */
    constructor(opcode, type, inputs = {}) {
        /**
         * @type {InputOpcode}
         */
        this.opcode = opcode;

        /**
         * @type {InputType}
         */
        this.type = type;

        /**
         * @type {Object}
         */
        this.inputs = inputs;
    }

    isConstant(value) {
        if (this.opcode !== InputOpcode.CONSTANT) return false;
        var equal = this.inputs.value === value;
        if (!equal && typeof value === "number") equal = (+this.inputs.value) === value;
        return equal;
    }

    isAlwaysType(type) {
        return (this.type & type) === this.type;
    }

    isSometimesType(type) {
        return (this.type & type) !== 0;
    }

    isNeverType(type) {
        return !this.isSometimesType(type);
    }

    // TDTODO Document
    toType(targetType) {
        let castOpcode;
        switch (targetType) {
            case InputType.BOOLEAN:
                castOpcode = InputOpcode.CAST_BOOLEAN;
                break;
            case InputType.NUMBER:
                castOpcode = InputOpcode.CAST_NUMBER;
                break;
            case InputType.NUMBER_OR_NAN:
                castOpcode = InputOpcode.CAST_NUMBER_OR_NAN;
                break;
            case InputType.STRING:
                castOpcode = InputOpcode.CAST_STRING;
                break;
            default:
                log.warn(`IR: Cannot cast to type: ${targetType}`, this);
                throw new Error(`IR: Cannot cast to type: ${targetType}`);
        }
        
        if (this.isAlwaysType(targetType)) return this;

        if (this.opcode === InputOpcode.CONSTANT) {
            // If we are a constant, we can do the cast here at compile time
            switch (castOpcode) {
                case InputOpcode.CAST_BOOLEAN:
                    this.inputs.value = Cast.toBoolean(this.inputs.value);
                    this.type = InputType.BOOLEAN;
                    break;
                case InputOpcode.CAST_NUMBER:
                case InputOpcode.CAST_NUMBER_OR_NAN:
                    const numberValue = +this.inputs.value;
                    if (numberValue) {
                        this.inputs.value = numberValue;
                    } else {
                        // numberValue is one of 0, -0, or NaN
                        if (Object.is(numberValue, -0)) this.inputs.value = -0;
                        else this.inputs.value = 0; // Convert NaN to 0
                    }
                    this.type = InputType.NUMBER;
                    break;
                case InputOpcode.CAST_STRING:
                    this.inputs.value += '';
                    this.type = InputType.STRING;
                    break;
            }
            return this;
        }

        return new IntermediateInput(castOpcode, targetType, { target: this });
    }
}

/**
 * An IntermediateScript describes a single script.
 * Scripts do not necessarily have hats.
 */
class IntermediateScript {
    constructor() {
        /**
         * The ID of the top block of this script.
         * @type {string}
         */
        this.topBlockId = null;

        /**
         * List of nodes that make up this script.
         * @type {IntermediateStack[]}
         */
        this.stack = null;

        /**
         * Whether this script is a procedure.
         * @type {boolean}
         */
        this.isProcedure = false;

        /**
         * This procedure's code, if any.
         * @type {string}
         */
        this.procedureCode = '';

        /**
         * List of names of arguments accepted by this function, if it is a procedure.
         * @type {string[]}
         */
        this.arguments = [];

        /**
         * Whether this script should be run in warp mode.
         * @type {boolean}
         */
        this.isWarp = false;

        /**
         * Whether this script can `yield`
         * If false, this script will be compiled as a regular JavaScript function (function)
         * If true, this script will be compiled as a generator function (function*)
         * @type {boolean}
         */
        this.yields = true;

        /**
         * Whether this script should use the "warp timer"
         * @type {boolean}
         */
        this.warpTimer = false;

        /**
         * List of procedure IDs that this script needs.
         * @readonly
         */
        this.dependedProcedures = [];

        /**
         * Cached result of compiling this script.
         * @type {Function|null}
         */
        this.cachedCompileResult = null;

        /**
         * Whether the top block of this script is an executable hat.
         * @type {boolean}
         */
        this.executableHat = false;
    }
}

/**
 * An IntermediateRepresentation contains scripts.
 */
class IntermediateRepresentation {
    constructor() {
        /**
         * The entry point of this IR.
         * @type {IntermediateScript}
         */
        this.entry = null;

        /**
         * Maps procedure variants to their intermediate script.
         * @type {Object.<string, IntermediateScript>}
         */
        this.procedures = {};
    }
}

module.exports = {
    IntermediateStack,
    IntermediateInput,
    IntermediateScript,
    IntermediateRepresentation
};
