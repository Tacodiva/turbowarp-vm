const { IntermediateStack, IntermediateInput, IntermediateScript, IntermediateRepresentation } = require('./intermediate');
const { StackOpcode, InputOpcode, InputType } = require('./enums.js')

class TypeState {
    constructor() {
        /** @type {object.<string, InputType>}*/
        this.variables = {};
    }

    clone() {
        var clone = new TypeState();
        for (const varId in this.variables) {
            clone.variables[varId] = this.variables[varId];
        }
        return clone;
    }

    setAll(other) {
        this.variables = other.variables;
    }

    or(other) {
        let modified = false;
        for (const varId in other.variables) {
            const currentType = this.variables[varId] ?? InputType.ANY;
            const newType = currentType | other.variables[varId];
            this.variables[varId] = newType;
            modified |= currentType !== newType;
        }
        return modified;
    }

    /**
     * @param {*} variable A variable codegen object.
     * @param {InputType} type The type to set this variable to
     * @returns {boolean}
     */
    setVariableType(variable, type) {
        console.log("Setting " + variable.name + " to " + type);
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
            }

            case InputOpcode.OP_ADD: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    if (leftType & InputType.NUMBER_NAN) return true; // ANY + NaN = NaN
                    if (rightType & InputType.NUMBER_NAN) return true; // NaN + ANY = NaN
                    // Infinity + (-Infinity) = NaN
                    if (leftType & InputType.NUMBER_POS_INF & rightType & InputType.NUMBER_NEG_INF) return true;
                    // (-Infinity) + (Infinity) = NaN
                    if (leftType & InputType.NUMBER_NEG_INF & rightType & InputType.NUMBER_POS_INF) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBePos() {
                    if (leftType & InputType.NUMBER_POS) return true; // POS + ANY ~= POS
                    if (rightType & InputType.NUMBER_POS) return true; // ANY + POS ~= POS
                }
                if (canBePos()) resultType |= InputType.NUMBER_POS;

                function canBeNeg() {
                    if (leftType & InputType.NUMBER_NEG) return true; // NEG + ANY ~= NEG
                    if (rightType & InputType.NUMBER_NEG) return true; // ANY + NEG ~= NEG
                }
                if (canBeNeg()) resultType |= InputType.NUMBER_NEG;

                function canBeZero() {
                    // POS_REAL + NEG_REAL ~= 0
                    if (leftType & InputType.NUMBER_POS_REAL & rightType & InputType.NUMBER_NEG_REAL) return true;
                    // NEG_REAL + POS_REAL ~= 0
                    if (leftType & InputType.NUMBER_NEG_REAL & rightType & InputType.NUMBER_POS_REAL) return true;
                    // 0 + 0 = 0
                    if (leftType & InputType.NUMBER_ZERO & rightType & InputType.NUMBER_ZERO) return true;
                    // 0 + -0 = 0
                    if (leftType & InputType.NUMBER_ZERO & rightType & InputType.NUMBER_NEG_ZERO) return true;
                    // -0 + 0 = 0
                    if (leftType & InputType.NUMBER_NEG_ZERO & rightType & InputType.NUMBER_ZERO) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                function canBeNegZero() {
                    // -0 + -0 = -0
                    if (leftType & InputType.NUMBER_NEG_ZERO & rightType & InputType.NUMBER_NEG_ZERO) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;
                console.log(leftType + " + " + rightType + " = " + resultType);

                return resultType;
            }
        }

        return inputBlock.type;
    }

    /**
     * @param {IntermediateStack} stackBlock 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStackBlock(stackBlock, state) {
        const inputs = stackBlock.inputs;

        switch (stackBlock.opcode) {
            case StackOpcode.VAR_SET:
                return state.setVariableType(inputs.variable, this.analyzeInputBlock(inputs.value, state));
            case StackOpcode.CONTROL_WHILE:
                return this.analyzeLoopedStack(inputs.do, state);
        }
    }

    /**
     * @param {IntermediateStack[]} stack 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStack(stack, state) {
        let modified = false;
        for (const stackBlock of stack) {
            const stateChanged = this.analyzeStackBlock(stackBlock, state);

            if (stateChanged) {
                stackBlock.typeState = state.clone();
                modified = true;
            }
        }
        return modified;
    }

    /**
     * @param {IntermediateStack[]} stack 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeLoopedStack(stack, state) {
        let modified = false;
        let keepLooping;
        do {
            const newState = state.clone();
            this.analyzeStack(stack, newState);
            modified |= keepLooping = state.or(newState);
        } while (keepLooping);
        return modified;
    }

    optimize() {
        const state = new TypeState();
        this.analyzeStack(this.ir.entry.stack, state);
        console.log(state);
    }
}


module.exports = IROptimizer;