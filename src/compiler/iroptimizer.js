// @ts-check

const { IntermediateStack, IntermediateInput, IntermediateScript, IntermediateRepresentation, IntermediateStackBlock } = require('./intermediate');
const { StackOpcode, InputOpcode, InputType } = require('./enums.js')

class TypeState {
    constructor() {
        /** @type {Object.<string, InputType>}*/
        this.variables = {};
    }

    /**
     * @returns {boolean}
     */
    clear() {
        let modified = false;
        for (const varId in this.variables) {
            if (this.variables[varId] !== InputType.ANY) {
                modified = true;
                break;
            }
        }
        this.variables = {};
        return modified;
    }


    /**
     * @returns {TypeState}
     */
    clone() {
        var clone = new TypeState();
        for (const varId in this.variables) {
            clone.variables[varId] = this.variables[varId];
        }
        return clone;
    }

    /**
     * @param {TypeState} other 
     */
    setAll(other) {
        this.variables = other.variables;
    }

    /**
     * @param {TypeState} other 
     * @returns {boolean}
     */
    or(other) {
        let modified = false;
        for (const varId in other.variables) {
            const currentType = this.variables[varId] ?? InputType.ANY;
            const newType = currentType | other.variables[varId];
            this.variables[varId] = newType;
            modified ||= currentType !== newType;
        }
        for (const varId in this.variables) {
            if (!other.variables[varId]) {
                if (this.variables[varId] !== InputType.ANY) {
                    this.variables[varId] = InputType.ANY;
                    modified = true;
                }
            }
        }
        return modified;
    }

    /**
     * @param {*} variable A variable codegen object.
     * @param {InputType} type The type to set this variable to
     * @returns {boolean}
     */
    setVariableType(variable, type) {
        if (this.getVariableType(variable) === type) return false;
        this.variables[variable.name] = type;
        return true;
    }

    /**
     * 
     * @param {*} variable A variable codegen object.
     * @returns {InputType}
     */
    getVariableType(variable) {
        return this.variables[variable.name] ?? InputType.ANY;
    }
}

class IROptimizer {

    /**
     * @param {IntermediateRepresentation} ir 
     */
    constructor(ir) {
        /** @type {IntermediateRepresentation} */
        this.ir = ir;
    }

    /**
     * @param {IntermediateInput} inputBlock 
     * @param {TypeState} state 
     * @returns {InputType}
     */
    analyzeInputBlock(inputBlock, state) {
        const inputs = inputBlock.inputs;

        switch (inputBlock.opcode) {
            case InputOpcode.VAR_GET:
                return state.getVariableType(inputs.variable);

            case InputOpcode.CAST_NUMBER: {
                const innerType = this.analyzeInputBlock(inputs.target, state);
                if (innerType & InputType.NUMBER) return innerType;
                return InputType.NUMBER;
            } case InputOpcode.CAST_NUMBER_OR_NAN: {
                const innerType = this.analyzeInputBlock(inputs.target, state);
                if (innerType & InputType.NUMBER_OR_NAN) return innerType;
                return InputType.NUMBER_OR_NAN;
            }

            case InputOpcode.OP_ADD: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    // Infinity + (-Infinity) = NaN
                    if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_NEG_INF)) return true;
                    // (-Infinity) + Infinity = NaN
                    if ((leftType & InputType.NUMBER_NEG_INF) && (rightType & InputType.NUMBER_POS_INF)) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBeFractional() {
                    // For the plus operation to return a non-whole number one of it's
                    //  inputs has to be a non-whole number
                    if (leftType & InputType.NUMBER_FRACT) return true;
                    if (rightType & InputType.NUMBER_FRACT) return true;
                }
                const canBeFract = canBeFractional();

                function canBePos() {
                    if (leftType & InputType.NUMBER_POS) return true; // POS + ANY ~= POS
                    if (rightType & InputType.NUMBER_POS) return true; // ANY + POS ~= POS
                }
                if (canBePos()) {
                    resultType |= InputType.NUMBER_POS_INT | InputType.NUMBER_POS_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_POS_FRACT;
                }

                function canBeNeg() {
                    if (leftType & InputType.NUMBER_NEG) return true; // NEG + ANY ~= NEG
                    if (rightType & InputType.NUMBER_NEG) return true; // ANY + NEG ~= NEG
                }
                if (canBeNeg()) {
                    resultType |= InputType.NUMBER_NEG_INT | InputType.NUMBER_NEG_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_NEG_FRACT;
                }

                function canBeZero() {
                    // POS_REAL + NEG_REAL ~= 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                    // NEG_REAL + POS_REAL ~= 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // 0 + 0 = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // 0 + -0 = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                    // -0 + 0 = 0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                // TDTODO Is this necessary?
                function canBeNegZero() {
                    // -0 + -0 = -0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;

                return resultType;
            }

            case InputOpcode.OP_SUBTRACT: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    // Infinity - Infinity = NaN
                    if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_POS_INF)) return true;
                    // (-Infinity) - (-Infinity) = NaN
                    if ((leftType & InputType.NUMBER_NEG_INF) && (rightType & InputType.NUMBER_NEG_INF)) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBeFractional() {
                    // For the subtract operation to return a non-whole number one of it's
                    //  inputs has to be a non-whole number
                    if (leftType & InputType.NUMBER_FRACT) return true;
                    if (rightType & InputType.NUMBER_FRACT) return true;
                }
                const canBeFract = canBeFractional();

                function canBePos() {
                    if (leftType & InputType.NUMBER_POS) return true; // POS - ANY ~= POS
                    if (rightType & InputType.NUMBER_NEG) return true; // ANY - NEG ~= POS
                }
                if (canBePos()) {
                    resultType |= InputType.NUMBER_POS_INT | InputType.NUMBER_POS_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_POS_FRACT;
                }

                function canBeNeg() {
                    if (leftType & InputType.NUMBER_NEG) return true; // NEG - ANY ~= NEG
                    if (rightType & InputType.NUMBER_POS) return true; // ANY - POS ~= NEG
                }
                if (canBeNeg()) {
                    resultType |= InputType.NUMBER_NEG_INT | InputType.NUMBER_NEG_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_NEG_FRACT;
                }

                function canBeZero() {
                    // POS_REAL - POS_REAL ~= 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // NEG_REAL - NEG_REAL ~= 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                    // 0 - 0 = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // 0 - (-0) = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                    // (-0) - (-0) = 0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                function canBeNegZero() {
                    // (-0) - 0 = -0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;

                return resultType;
            }

            case InputOpcode.OP_MULTIPLY: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    // Infinity * 0 = NaN
                    if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_ANY_ZERO)) return true;
                    // 0 * Infinity = NaN
                    if ((leftType & InputType.NUMBER_ANY_ZERO) && (rightType & InputType.NUMBER_POS_INF)) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBeFractional() {
                    // For the subtract operation to return a non-whole number one of it's
                    //  inputs has to be a non-whole number
                    if (leftType & InputType.NUMBER_FRACT) return true;
                    if (rightType & InputType.NUMBER_FRACT) return true;
                }
                const canBeFract = canBeFractional();

                function canBePos() {
                    // POS * POS = POS
                    if ((leftType & InputType.NUMBER_POS) && (rightType & InputType.NUMBER_POS)) return true;
                    // NEG * NEG = POS
                    if ((leftType & InputType.NUMBER_NEG) && (rightType & InputType.NUMBER_NEG)) return true;
                }
                if (canBePos()) {
                    resultType |= InputType.NUMBER_POS_INT | InputType.NUMBER_POS_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_POS_FRACT;
                }

                function canBeNeg() {
                    // POS * NEG = NEG
                    if ((leftType & InputType.NUMBER_POS) && (rightType & InputType.NUMBER_NEG)) return true;
                    // NEG * POS = NEG
                    if ((leftType & InputType.NUMBER_NEG) && (rightType & InputType.NUMBER_POS)) return true;
                }
                if (canBeNeg()) {
                    resultType |= InputType.NUMBER_NEG_INT | InputType.NUMBER_NEG_INF;
                    if (canBeFract) resultType |= InputType.NUMBER_NEG_FRACT;
                }

                function canBeZero() {
                    // 0 * POS_REAL = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // -0 * NEG_REAL = 0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                    // POS_REAL * 0 = 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // NEG_REAL * -0 = 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                    // Rounding errors like 1e-323 * 0.1 = 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // Rounding errors like -1e-323 / -0.1 = 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                function canBeNegZero() {
                    // -0 * POS_REAL = -0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // 0 * NEG_REAL = -0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                    // POS_REAL * -0 = -0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                    // NEG_REAL * 0 = -0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // Rounding errors like -1e-323 / 10 = -0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // Rounding errors like 1e-323 / -10 = -0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;

                return resultType;
            }

            case InputOpcode.OP_DIVIDE: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    // REAL / 0 = NaN
                    if ((leftType & InputType.NUMBER_REAL) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // Infinity / Infinity = NaN
                    if ((leftType & InputType.NUMBER_INF) && (rightType & InputType.NUMBER_INF)) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBePos() {
                    // POS / POS = POS
                    if ((leftType & InputType.NUMBER_POS) && (rightType & InputType.NUMBER_POS)) return true;
                    // NEG / NEG = POS
                    if ((leftType & InputType.NUMBER_NEG) && (rightType & InputType.NUMBER_NEG)) return true;
                }
                if (canBePos()) resultType |= InputType.NUMBER_POS;

                // -Infinity / 0 = -Infinity
                if ((leftType & InputType.NUMBER_NEG_INF) && (rightType & InputType.NUMBER_ZERO))
                    resultType |= InputType.NUMBER_NEG_INF;
                // Infinity / -0 = -Infinity
                if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_NEG_ZERO))
                    resultType |= InputType.NUMBER_NEG_INF;

                // Infinity / 0 = Infinity
                if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_ZERO))
                    resultType |= InputType.NUMBER_POS_INF;
                // -Infinity / -0 = Infinity
                if ((leftType & InputType.NUMBER_NEG_INF) && (rightType & InputType.NUMBER_NEG_ZERO))
                    resultType |= InputType.NUMBER_POS_INF;

                function canBeNeg() {
                    // POS / NEG = NEG
                    if ((leftType & InputType.NUMBER_POS) && (rightType & InputType.NUMBER_NEG)) return true;
                    // NEG / POS = NEG
                    if ((leftType & InputType.NUMBER_NEG) && (rightType & InputType.NUMBER_POS)) return true;
                }
                if (canBeNeg()) resultType |= InputType.NUMBER_NEG;

                function canBeZero() {
                    // 0 / POS = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_POS)) return true;
                    // -0 / NEG = 0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_NEG)) return true;
                    // Rounding errors like 1e-323 / 10 = 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // Rounding errors like -1e-323 / -10 = 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                function canBeNegZero() {
                    // -0 / POS = -0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_POS)) return true;
                    // 0 / NEG = -0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_NEG)) return true;
                    // Rounding errors like -1e-323 / 10 = -0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // Rounding errors like 1e-323 / -10 = -0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;

                return resultType;
            }
        }

        return inputBlock.type;
    }

    /**
     * @param {IntermediateStackBlock} stackBlock 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStackBlock(stackBlock, state) {
        const inputs = stackBlock.inputs;

        switch (stackBlock.opcode) {
            case StackOpcode.VAR_SET:
                return state.setVariableType(inputs.variable, this.analyzeInputBlock(inputs.value, state));
            case StackOpcode.CONTROL_WHILE:
            case StackOpcode.CONTROL_FOR:
            case StackOpcode.CONTROL_REPEAT:
                return this.analyzeLoopedStack(inputs.do, state, stackBlock);
            case StackOpcode.CONTROL_IF_ELSE: {
                const trueState = state.clone();
                this.analyzeStack(inputs.whenTrue, trueState);
                let modified = this.analyzeStack(inputs.whenFalse, state);
                modified ||= state.or(trueState);
                return modified;
            } case StackOpcode.PROCEDURE_CALL:
                // TDTODO If we've analyzed the procedure we can grab it's type info
                // instead of resetting everything.
                return state.clear();
        }

        return false;
    }

    /**
     * @param {IntermediateStack?} stack 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStack(stack, state) {
        if (!stack) return false;
        let modified = false;
        for (const stackBlock of stack.blocks) {
            let stateChanged = this.analyzeStackBlock(stackBlock, state);
            if (stackBlock.yields) stateChanged ||= state.clear();

            if (stateChanged) {
                if (stackBlock.exitState) stackBlock.exitState.or(state);
                else stackBlock.exitState = state.clone();
                modified = true;
            }
        }
        return modified;
    }

    /**
     * @param {IntermediateStack} stack 
     * @param {TypeState} state 
     * @param {IntermediateStackBlock} block
     * @returns {boolean}
     */
    analyzeLoopedStack(stack, state, block) {
        if (block.yields) {
            let modified = state.clear();
            block.entryState = state.clone();
            block.exitState = state.clone();
            return this.analyzeStack(stack, state) || modified;
        } else {
            let modified = false;
            let keepLooping;
            do {
                const newState = state.clone();
                this.analyzeStack(stack, newState);
                modified = keepLooping = state.or(newState);
            } while (keepLooping);
            block.entryState = state.clone();
            return modified;
        }
    }

    /**
     * @param {IntermediateInput} input 
     * @param {TypeState} state 
     * @returns {IntermediateInput}
     */
    optimizeInput(input, state) {
        for (const inputKey in input.inputs) {
            const inputInput = input.inputs[inputKey];
            if (inputInput instanceof IntermediateInput)
                input.inputs[inputKey] = this.optimizeInput(inputInput, state);
        }

        switch (input.opcode) {
            case InputOpcode.CAST_NUMBER: {
                const targetType = this.analyzeInputBlock(input.inputs.target, state);
                if ((targetType & InputType.NUMBER) === targetType)
                    return input.inputs.target;
                return input;
            } case InputOpcode.CAST_NUMBER_OR_NAN: {
                const targetType = this.analyzeInputBlock(input.inputs.target, state);
                if ((targetType & InputType.NUMBER_OR_NAN) === targetType)
                    return input.inputs.target;
                return input;
            }
        }

        input.type = this.analyzeInputBlock(input, state);
        return input;
    }

    /**
     * @param {IntermediateStack?} stack 
     * @param {TypeState} state 
     */
    optimizeStack(stack, state) {
        if (!stack) return;
        for (const stackBlock of stack.blocks) {
            if (stackBlock.entryState) state = stackBlock.entryState;
            for (const inputKey in stackBlock.inputs) {
                const input = stackBlock.inputs[inputKey];
                if (input instanceof IntermediateInput) {
                    stackBlock.inputs[inputKey] = this.optimizeInput(input, state);
                } else if (input instanceof IntermediateStack) {
                    this.optimizeStack(input, state);
                }
            }
            if (stackBlock.exitState)
                state = stackBlock.exitState;
        }
    }

    optimize() {
        const state = new TypeState();

        for (const procVariant of this.ir.entry.dependedProcedures) {
            const procedure = this.ir.procedures[procVariant];
            this.analyzeStack(procedure.stack, state);
            this.optimizeStack(procedure.stack, state);
        }

        this.analyzeStack(this.ir.entry.stack, state);
        this.optimizeStack(this.ir.entry.stack, state);
    }
}


module.exports = {
    IROptimizer,
    TypeState
};