import type { AnyObject } from '@monorepo/common';
import { consoleLogger } from '@monorepo/common';
import * as _ from 'lodash-es';
import { plural } from 'pluralize';
import type { Dispatch } from 'redux';
import { kindToAbbr } from '../../k8s/k8s-resource';
import type {
  APIResourceList,
  DiscoveryResources,
  InitAPIDiscovery,
} from '../../types/api-discovery';
import type { K8sModelCommon } from '../../types/k8s';
import type { DispatchWithThunk } from '../../types/redux';
import { commonFetchJSON } from '../../utils/common-fetch';
import { getResourcesInFlight, receivedResources } from '../redux/actions/k8s';
import { cacheResources, getCachedResources } from './discovery-cache';

const POLLs: { [id: string]: number } = {};
const apiDiscovery = 'apiDiscovery';
const API_DISCOVERY_POLL_INTERVAL = 60_000;
const API_DISCOVERY_INIT_DELAY = 15_000;
const API_DISCOVERY_REQUEST_BATCH_SIZE = 5;

const pluralizeKind = (kind: string): string => {
  // Use startCase to separate words so the last can be pluralized but remove spaces so as not to humanize
  const pluralized = plural(_.startCase(kind)).replace(/\s+/g, '');
  // Handle special cases like DB -> DBs (instead of DBS).
  if (pluralized === `${kind}S`) {
    return `${kind}s`;
  }
  return pluralized;
};

const defineModels = (list: APIResourceList): K8sModelCommon[] => {
  const { apiGroup, apiVersion } = list;
  if (!list.resources || list.resources.length < 1) {
    return [];
  }
  return list.resources
    .filter(({ name }) => !name.includes('/'))
    .map(
      ({ name, singularName, namespaced, kind, verbs, shortNames }) =>
        <K8sModelCommon>{
          ...(apiGroup ? { apiGroup } : {}),
          apiVersion,
          kind,
          namespaced,
          verbs,
          shortNames,
          plural: name,
          crd: true,
          abbr: kindToAbbr(kind),
          labelPlural: pluralizeKind(kind),
          path: name,
          id: singularName,
          label: kind,
        },
    );
};

type APIResourceData = {
  groups: {
    name: string;
    versions: {
      groupVersion: unknown;
    }[];
    preferredVersion: { version: unknown };
  }[];
};

const getResources = async (): Promise<DiscoveryResources> => {
  const apiResourceData: APIResourceData = await commonFetchJSON('/apis');
  const groupVersionMap = apiResourceData.groups.reduce(
    (acc: AnyObject, { name, versions, preferredVersion: { version } }) => {
      acc[name] = {
        versions: _.map(versions, 'version'),
        preferredVersion: version,
      };
      return acc;
    },
    {},
  );
  const all = _.flatten(
    apiResourceData.groups.map<string[]>((group) =>
      group.versions.map<string>((version) => `/apis/${version.groupVersion}`),
    ),
  ).concat(['/api/v1']);

  let batchedData: APIResourceList[] = [];
  const batches = _.chunk(all, API_DISCOVERY_REQUEST_BATCH_SIZE);
  // forEach does not play nice with async awaits
  // eslint-disable-next-line no-restricted-syntax
  for (const batch of batches) {
    // eslint-disable-next-line no-await-in-loop
    const result = await Promise.all(
      batch.map<Promise<APIResourceList>>((p: string) =>
        commonFetchJSON<K8sModelCommon>(p).catch((err) => err),
      ),
    );
    batchedData = _.concat(batchedData, result);
  }

  return Promise.resolve(batchedData).then((data) => {
    const resourceSet = new Set<string>();
    const namespacedSet = new Set<string>();
    data.forEach(
      (d) =>
        d.resources &&
        d.resources.forEach(({ namespaced, name }) => {
          resourceSet.add(name);
          if (namespaced) {
            namespacedSet.add(name);
          }
        }),
    );
    const allResources = [...resourceSet].sort();

    const safeResources: string[] = [];
    const adminResources: string[] = [];
    const models = _.flatten(data.filter((d) => d.resources).map(defineModels));
    const coreResources = new Set([
      'roles',
      'rolebindings',
      'clusterroles',
      'clusterrolebindings',
      'thirdpartyresources',
      'nodes',
      'secrets',
    ]);
    allResources.forEach((r) =>
      coreResources.has(r.split('/')[0]) ? adminResources.push(r) : safeResources.push(r),
    );
    const configResources = _.filter(
      models,
      (m) => m.apiGroup === 'config.openshift.io' && m.kind !== 'ClusterOperator',
    );
    const clusterOperatorConfigResources = _.filter(
      models,
      (m) => m.apiGroup === 'operator.openshift.io',
    );

    return {
      allResources,
      safeResources,
      adminResources,
      configResources,
      clusterOperatorConfigResources,
      namespacedSet,
      models,
      groupVersionMap,
    } as DiscoveryResources;
  });
};

const updateResources =
  () =>
  (dispatch: Dispatch): Promise<DiscoveryResources> => {
    dispatch(getResourcesInFlight());

    return getResources().then((resources) => {
      // Cache the resources whenever discovery completes to improve console load times.
      debugger;
      cacheResources(resources);
      dispatch(receivedResources(resources));
      return resources;
    });
  };

const startAPIDiscovery = () => (dispatch: DispatchWithThunk) => {
  consoleLogger.info(
    `API discovery startAPIDiscovery: Polling every ${API_DISCOVERY_POLL_INTERVAL} ms`,
  );
  // Poll API discovery since we can't watch CRDs
  dispatch(updateResources())
    .then((resources) => {
      if (POLLs[apiDiscovery]) {
        clearTimeout(POLLs[apiDiscovery]);
        delete POLLs[apiDiscovery];
      }
      POLLs[apiDiscovery] = window.setTimeout(
        () => dispatch(startAPIDiscovery()),
        API_DISCOVERY_POLL_INTERVAL,
      );
      return resources;
    })
    // TODO handle failures - retry if error is recoverable
    .catch((err) => consoleLogger.error('API discovery startAPIDiscovery polling failed:', err));
};

export const initAPIDiscovery: InitAPIDiscovery = (storeInstance) => {
  consoleLogger.info(`API discovery waiting ${API_DISCOVERY_INIT_DELAY} ms before initializing`);
  const initDelay = new Promise((resolve) => {
    window.setTimeout(resolve, API_DISCOVERY_INIT_DELAY);
  });
  initDelay
    .then(() => {
      return getCachedResources();
    })
    .then((resources) => {
      if (resources) {
        storeInstance.dispatch(receivedResources(resources));
      }
      // Still perform discovery to refresh the cache.
      storeInstance.dispatch(startAPIDiscovery());
      return resources;
    })
    .catch(() => storeInstance.dispatch(startAPIDiscovery()));
};
