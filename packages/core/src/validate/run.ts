import { Node } from 'solidity-ast/node';
import { isNodeType, findAll } from 'solidity-ast/utils';
import type { ContractDefinition } from 'solidity-ast';

import { SolcOutput, SolcBytecode } from '../solc-api';
import { SrcDecoder } from '../src-decoder';
import { astDereferencer } from '../ast-dereferencer';
import { isNullish } from '../utils/is-nullish';
import { Version, getVersion } from '../version';
import { extractLinkReferences, LinkReference } from '../link-refs';
import { extractStorageLayout } from '../storage/extract';
import { StorageLayout } from '../storage/layout';

export type ValidationRunData = Record<string, ContractValidation>;

export interface ContractValidation {
  version?: Version;
  inherit: string[];
  libraries: string[];
  linkReferences: LinkReference[];
  errors: ValidationError[];
  layout: StorageLayout;
}

export type ValidationError = ValidationErrorConstructor | ValidationErrorOpcode | ValidationErrorWithName;

interface ValidationErrorBase {
  src: string;
}

interface ValidationErrorWithName extends ValidationErrorBase {
  name: string;
  kind:
    | 'state-variable-assignment'
    | 'state-variable-immutable'
    | 'external-library-linking'
    | 'struct-definition'
    | 'enum-definition';
}

interface ValidationErrorConstructor extends ValidationErrorBase {
  kind: 'constructor';
  contract: string;
}

interface ValidationErrorOpcode extends ValidationErrorBase {
  kind: 'delegatecall' | 'selfdestruct';
}

function* execall(re: RegExp, text: string) {
  re = new RegExp(re, re.flags + (re.sticky ? '' : 'y'));
  while (true) {
    const match = re.exec(text);
    if (match && match[0] !== '') {
      yield match;
    } else {
      break;
    }
  }
}

function getAllowed(node: Node): string[] {
  if ('documentation' in node) {
    const doc = typeof node.documentation === 'string' ? node.documentation : node.documentation?.text ?? '';

    const result: string[] = [];
    for (const { groups } of execall(
      /^(?:@(?<title>\w+)(?::(?<tag>[a-z][a-z-]*))? )?(?<args>(?:(?!^@\w+ )[^])*)/m,
      doc,
    )) {
      if (groups && groups.title === 'custom' && groups.tag === 'oz-upgrades-unsafe-allow') {
        result.push(...groups.args.split(/\s+/));
      }
    }

    result.forEach(arg => {
      if (
        ![
          'state-variable-assignment',
          'state-variable-immutable',
          'external-library-linking',
          'struct-definition',
          'enum-definition',
          'constructor',
          'delegatecall',
          'selfdestruct',
        ].includes(arg)
      ) {
        throw new Error(`NatSpec: openzeppelin-upgrade-allow argument not recognized: ${arg}`);
      }
    });

    return result;
  } else {
    return [];
  }
}

function skipCheck(error: string, node: Node): boolean {
  return getAllowed(node).includes(error);
}

export function validate(solcOutput: SolcOutput, decodeSrc: SrcDecoder): ValidationRunData {
  const validation: ValidationRunData = {};
  const fromId: Record<number, string> = {};
  const inheritIds: Record<string, number[]> = {};
  const libraryIds: Record<string, number[]> = {};

  const deref = astDereferencer(solcOutput);

  for (const source in solcOutput.contracts) {
    for (const contractName in solcOutput.contracts[source]) {
      const bytecode = solcOutput.contracts[source][contractName].evm.bytecode;
      const version = bytecode.object === '' ? undefined : getVersion(bytecode.object);
      const linkReferences = extractLinkReferences(bytecode);

      validation[contractName] = {
        version,
        inherit: [],
        libraries: [],
        linkReferences,
        errors: [],
        layout: {
          storage: [],
          types: {},
        },
      };
    }

    for (const contractDef of findAll('ContractDefinition', solcOutput.sources[source].ast)) {
      fromId[contractDef.id] = contractDef.name;

      // May be undefined in case of duplicate contract names in Truffle
      const bytecode = solcOutput.contracts[source][contractDef.name]?.evm.bytecode;

      if (contractDef.name in validation && bytecode !== undefined) {
        inheritIds[contractDef.name] = contractDef.linearizedBaseContracts.slice(1);
        libraryIds[contractDef.name] = getReferencedLibraryIds(contractDef);

        validation[contractDef.name].errors = [
          ...getConstructorErrors(contractDef, decodeSrc),
          ...getOpcodeErrors(contractDef, decodeSrc),
          ...getStateVariableErrors(contractDef, decodeSrc),
          // TODO: add linked libraries support
          // https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/52
          ...getLinkingErrors(contractDef, bytecode),
        ];

        validation[contractDef.name].layout = extractStorageLayout(contractDef, decodeSrc, deref);
      }
    }
  }

  for (const contractName in inheritIds) {
    validation[contractName].inherit = inheritIds[contractName].map(id => fromId[id]);
  }

  for (const contractName in libraryIds) {
    validation[contractName].libraries = libraryIds[contractName].map(id => fromId[id]);
  }

  return validation;
}

function* getConstructorErrors(contractDef: ContractDefinition, decodeSrc: SrcDecoder): Generator<ValidationError> {
  for (const fnDef of findAll('FunctionDefinition', contractDef, node => skipCheck('constructor', node))) {
    if (fnDef.kind === 'constructor' && ((fnDef.body?.statements.length ?? 0) > 0 || fnDef.modifiers.length > 0)) {
      yield {
        kind: 'constructor',
        contract: contractDef.name,
        src: decodeSrc(fnDef),
      };
    }
  }
}

function* getOpcodeErrors(contractDef: ContractDefinition, decodeSrc: SrcDecoder): Generator<ValidationErrorOpcode> {
  for (const fnCall of findAll('FunctionCall', contractDef, node => skipCheck('delegatecall', node))) {
    const fn = fnCall.expression;
    if (fn.typeDescriptions.typeIdentifier?.match(/^t_function_baredelegatecall_/)) {
      yield {
        kind: 'delegatecall',
        src: decodeSrc(fnCall),
      };
    }
  }
  for (const fnCall of findAll('FunctionCall', contractDef, node => skipCheck('selfdestruct', node))) {
    const fn = fnCall.expression;
    if (fn.typeDescriptions.typeIdentifier?.match(/^t_function_selfdestruct_/)) {
      yield {
        kind: 'selfdestruct',
        src: decodeSrc(fnCall),
      };
    }
  }
}

function* getStateVariableErrors(
  contractDef: ContractDefinition,
  decodeSrc: SrcDecoder,
): Generator<ValidationErrorWithName> {
  for (const varDecl of contractDef.nodes) {
    if (isNodeType('VariableDeclaration', varDecl)) {
      if (!varDecl.constant && !isNullish(varDecl.value)) {
        if (!skipCheck('state-variable-assignment', contractDef) && !skipCheck('state-variable-assignment', varDecl)) {
          yield {
            kind: 'state-variable-assignment',
            name: varDecl.name,
            src: decodeSrc(varDecl),
          };
        }
      }
      if (varDecl.mutability === 'immutable') {
        if (!skipCheck('state-variable-immutable', contractDef) && !skipCheck('state-variable-immutable', varDecl)) {
          yield {
            kind: 'state-variable-immutable',
            name: varDecl.name,
            src: decodeSrc(varDecl),
          };
        }
      }
    }
  }
}

function getReferencedLibraryIds(contractDef: ContractDefinition): number[] {
  const implicitUsage = [...findAll('UsingForDirective', contractDef)].map(
    usingForDirective => usingForDirective.libraryName.referencedDeclaration,
  );

  const explicitUsage = [...findAll('Identifier', contractDef)]
    .filter(identifier => identifier.typeDescriptions.typeString?.match(/^type\(library/))
    .map(identifier => {
      if (isNullish(identifier.referencedDeclaration)) {
        throw new Error('Broken invariant: Identifier.referencedDeclaration should not be null');
      }
      return identifier.referencedDeclaration;
    });

  return [...new Set(implicitUsage.concat(explicitUsage))];
}

function* getLinkingErrors(
  contractDef: ContractDefinition,
  bytecode: SolcBytecode,
): Generator<ValidationErrorWithName> {
  const { linkReferences } = bytecode;
  for (const source of Object.keys(linkReferences)) {
    for (const libName of Object.keys(linkReferences[source])) {
      if (!skipCheck('external-library-linking', contractDef)) {
        yield {
          kind: 'external-library-linking',
          name: libName,
          src: source,
        };
      }
    }
  }
}
