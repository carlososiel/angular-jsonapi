import {
    Http,
    Response,
    HttpModule,
    Headers
} from "@angular/http";
import {
    Injectable,
    Inject,
    ReflectiveInjector,
    Provider,
    NgModule,
    Optional,
    SkipSelf,
    OpaqueToken,
    ModuleWithProviders
} from "@angular/core";
import {Observable} from 'rxjs/Observable';
import 'rxjs/add/operator/map';
import 'rxjs/add/observable/of';
import 'rxjs/add/operator/catch';
import 'rxjs/add/observable/throw';
import 'rxjs/add/observable/forkJoin'
import 'rxjs/add/operator/switchMap'
import 'rxjs/add/operator/do'
import * as _ from 'lodash';

export function Attribute() {
    return function (target: any, propertyName: string) {

        let annotations = Reflect.getMetadata('Attributes', target) || [];
        annotations.push(propertyName);
        Reflect.defineMetadata('Attributes', annotations, target);

        let getter = function () {
            return this['_' + propertyName];
        };

        let setter = function (newVal: any) {
            this['_' + propertyName] = newVal;
        };

        if (delete target[propertyName]) {
            Object.defineProperty(target, propertyName, {
                get: getter,
                set: setter,
                enumerable: true,
                configurable: true
            });
        }
    };
}

export function Relationship(relationshipConstructor: Function) {
    return function (target: any, propertyName: string | symbol) {
        let annotations = Reflect.getMetadata('Relationships', target) || {};
        let targetType = Reflect.getMetadata('design:type', target, propertyName);
        annotations[propertyName] = {
            propertyName: propertyName,
            relationship: targetType,
            relationshipConstructor: relationshipConstructor
        };

        if (delete target[propertyName]) {

            Reflect.defineMetadata('Relationships', annotations, target);

            if (!_.get(target, propertyName)) {
                Object.defineProperty(target, propertyName as string, {
                    get: function () {
                        return this['_' + propertyName.toString()];
                    },
                    set: function (newVal: any) {
                        this['_' + propertyName.toString()] = newVal;
                    },
                    enumerable: true,
                    configurable: true
                });
            }
        }
    };
}

export interface IResourceConfig {
    type: string;
    uri?: string;
}

export function Resource(config: IResourceConfig) {
    return function (target: any) {
        Reflect.defineMetadata('Resource', config, target);
    };
}

export type ResourceType<T extends BaseResource> = { new (data?: any, original?: boolean): T; };

export abstract class BaseResource {

    id: string;
    private attributeStates: any;
    private resourcesToRemove: any[];
    createdAt: string;
    updatedAt: string;
    deletedAt: string;

    constructor(data?: any) {
        if (data) {
            if (data.attributes)
                this.initAttributes(data);
            else
            // when create a new resource from app
                this.initAttributes({attributes: data, id: data.id});
        }
    }

    /**
     * Set initial values in that method
     * @param data
     * @param original
     * @returns {BaseResource}
     */
    initAttributes(data: any) {

        this.attributeStates = {};
        this.resourcesToRemove = [];
        this.createdAt = null;
        if (!(data.id && !data.createdAt))
            this.createdAt = new Date().getTime().toString();
        this.createdAt = data.createdAt ? data.createdAt : this.createdAt;
        this.updatedAt = data.updatedAt ? data.updatedAt : this.updatedAt;
        this.deletedAt = data.deletedAt ? data.deletedAt : this.deletedAt;

        this.id = data.id;
        let self: any = this;
        let annotations = Reflect.getMetadata('Attributes', this);
        _.forEach(data.attributes, function (value: any, key: string) {
            if (_.findIndex(annotations, (attr: string) => attr === key) != -1) {
                self[key] = value;

                // Save attr state
                self.attributeStates[key] = {
                    originalValue: value,
                    value: value,
                    dirty: false
                }
            }

        });
        return this;
    }

    /**
     *
     * @param rm ResourceManager that handle http request
     * @returns {Observable<T>}
     */
    save(rm: ResourceManager): Observable<Response | any> {
        let self: any = this;
        let annotations = Reflect.getMetadata('Relationships', this) || {};
        let editAndCreateActions: Observable<any>[] = [];
        let newResources: any[] = [];

        _.each(annotations, (value: any, relationship: string) => {
            // if has this relationship
            if (self[relationship] && rm.isDirtyCollection(self[relationship]))
                editAndCreateActions.push(rm.saveCollection(self[relationship]))
        });

        if (!editAndCreateActions.length)
            editAndCreateActions.push(Observable.of([]));

        if (self.isNew()) {

            return Observable.forkJoin(editAndCreateActions)
                .do(([res]) => {
                    const {data} = res;
                    if (data) {
                        //Setting new resources
                        newResources = data.created;
                    }
                })
                .switchMap((res) => {
                    const uri = rm.buildUri(self, self.id);
                    return rm.http.post(uri, this.toJsonApi([]), {headers: rm.getHeaders()})
                        .map(res => res.json())
                        .map((res) => {
                            return self.initAttributes(res.data);
                        });
                })
                .switchMap((resource) => {
                    // Create relationship with new resources
                    return rm.createRelationship(resource, newResources);
                })
                .switchMap((res) => {
                    return Observable.of({data: self})
                });

        } else {


            return Observable.forkJoin(editAndCreateActions)
                .switchMap(([res]) => {
                    const {data} = res;
                    if (data) {
                        //Setting new resources
                        newResources = data.created;
                        // Create relationship with new resources
                        return rm.createRelationship(self, newResources);
                    } else
                        return Observable.of(null)

                })
                .switchMap((res) => {

                    // Update resource if dirty
                    if (self.isDirty()) {
                        const uri = rm.buildUri(self, self.id);
                        return rm.http.patch(uri, self.toJsonApi([], true), {headers: rm.getHeaders()})
                            .map(res => res.json())
                            .map((res) => {
                                return self.initAttributes(res.data);
                            });
                    } else
                        return Observable.of({data: self})

                })
        }
    }

    remove(rm: ResourceManager): Observable<Response | any> {
        const uri = rm.buildUri(this, this.id);
        const headers = rm.getHeaders();
        return rm.http.delete(uri, {headers: headers})
            .map(res => res.json())
            .map((res) => {
                return this.initAttributes(res.data);
            });
    }

    syncData(data: any): void {
        let self: any = this;
        const annotations = Reflect.getMetadata('Attributes', this);

        if (this.isNew())
            this.attributeStates = {};

        for (let index in annotations) {
            const attr = annotations[index];
            if (this.isNew()) {
                self[attr] = data[attr];
                self.attributeStates[attr] = {
                    originalValue: data[attr],
                    value: data[attr],
                    dirty: false
                };
            } else {
                //save attribute state
                if (!_.isEqual(self[attr], data[attr])) {
                    self[attr] = data[attr];
                    self.attributeStates[attr]['value'] = data[attr];
                    self.attributeStates[attr]['dirty'] = true;
                }
            }
        }
    }

    isDirty(): boolean {
        for (let key of Object.keys(this.attributeStates))
            if (this.attributeStates[key].dirty)
                return true;
        return false;
    }

    isNew(): boolean {
        return this.id ? false : true
    }

    /**
     * Return a resource un json-api format
     * @param relationShip resources that has a relationship with this resource
     * @returns {{data: {type, attributes: {}}}}
     */
    toJsonApi(relationShips: string[] = [], onlyDirtyAttributes: boolean = false) {
        let self: any = this;
        const resourceMeta = Reflect.getMetadata('Resource', this.constructor);
        const annotations = Reflect.getMetadata('Attributes', this);
        let data = {
            type: resourceMeta.type,
            attributes: {},
            relationships: {}
        };
        if (this.id) {
            _.set(data, 'id', this.id);
        }
        _.each(annotations, (attr: string) => {
            if (onlyDirtyAttributes) {
                if (self.attributeStates[attr].dirty)
                    _.set(data.attributes, attr, self[attr])

            } else {
                _.set(data.attributes, attr, self[attr])
            }
        });

        if (relationShips.length) {

            const relationshipsMetaData = Reflect.getMetadata('Relationships', this);
            _.each(relationShips, (value: any) => {
                let typeResource = value.type;

                if (relationshipsMetaData[typeResource]) {
                    let relation: any[] = [];
                    _.each(value.data, (id: any) => {
                        relation.push({type: typeResource, id: id})
                    });
                    _.set(data.relationships, typeResource, {data: relation});
                }
            });

            if (!_.keys(data.relationships).length)
                delete data.relationships;
        } else {
            delete data.relationships;
        }
        return {data: data};
    }

    syncRelationships(includedData: any[]) {
        let self: any = this;
        let annotations = Reflect.getMetadata('Relationships', self) || {};

        // Create relationship objects
        _.forEach(includedData, (value: any) => {
            let typeRelationship = value.type;
            if (typeRelationship) {
                let relationshipObject = annotations[typeRelationship];

                // if this resource has this relationship defined
                if (relationshipObject) {
                    let newRelationshipObject = Object.create(_.get(relationshipObject, 'relationshipConstructor.prototype'));
                    newRelationshipObject.initAttributes(value);
                    if (!self[typeRelationship] || !_.isArray(self[typeRelationship]))
                        self[typeRelationship] = [];
                    self[typeRelationship].push(newRelationshipObject);
                }
            }
        });
    }

    /**
     * Return data with json format
     */
    getData(showCreateAt: boolean = false): any {
        let self: any = this;
        let resourceData: any = {
            id: this.id,
            createdAt: this.createdAt
        };

        if (!showCreateAt)
            delete resourceData.createdAt;

        let attributes = Reflect.getMetadata('Attributes', this);

        _.forEach(attributes, (attr: string) => {
            resourceData[attr] = self[attr];
        });
        return resourceData;
    }
}

export class QueryBuilder {

    private _fields: string[] = [];
    private _sorts: string[] = [];
    private _filters: string[] = [];
    private _includes: string[] = [];

    private _pageSize: number;
    private _pageNumber: number;

    constructor(private resource: any, private rm: ResourceManager) {
    }

    fields(...args: string[]): QueryBuilder {
        this._fields = args;
        return this;
    }

    sortBy(...args: string[]): QueryBuilder {
        this._sorts = args;
        return this;
    }

    filters(...args: string[]): QueryBuilder {
        this._filters = args;
        return this;
    }

    include(...args: string[]): QueryBuilder {
        this._includes = args;
        return this;
    }

    limit(v: number): QueryBuilder {
        this._pageSize = v;
        return this;
    }

    page(v: number): QueryBuilder {
        this._pageNumber = v;
        return this;
    }

    private isAttribute(v: string): boolean {
        const attributesMetadata = Reflect.getMetadata('Attributes', new this.resource);
        return _.findIndex(attributesMetadata, (attr: string) => attr === v) != -1;
    }

    private validateAttributes() {
        const sortFields = this._sorts.reduce((pv: string[], cv: string) => {
            pv.push((cv[0] === '-') ? (cv.substr(1, cv.length)) : cv);
            return pv;
        }, []);
        const fields = this._fields.concat(this._filters, sortFields);
        for (let f of fields) {
            if (!this.isAttribute(f)) {
                console.warn(`The attribute ${f} is not part of resource`);
            }
        }
    }

    private validateRelationship() {
        const relationshipMetadata = Reflect.getMetadata('Relationships', new this.resource);
        for (let f of this._includes) {
            if (!relationshipMetadata.hasOwnProperty(f)) {
                console.warn(`The attribute ${f} don't have relationship with this resource, be shure that is definied in the class`);
            }
        }
    }

    private buildParameters(): string {
        let params: string[] = [];

        if (this._pageSize) {
            params.push(`page[size]=${this._pageSize}`);
        }
        if (this._pageNumber) {
            params.push(`page[number]=${this._pageNumber}`);
        }

        this.validateAttributes();

        if (this._fields.length) {
            params.push(`fields=${this._fields.join(',')}`);
        }

        this.validateRelationship();

        if (this._includes.length) {
            params.push(`include=${this._includes.join(',')}`);
        }

        if (this._filters.length) {
            params.push(`filter=${this._filters.join(',')}`);
        }

        if (this._sorts.length) {
            params.push(`sort=${this._sorts.join(',')}`);
        }

        return params.join('&');
    }

    execute(rm: ResourceManager, id?: string): Observable<any> {
        // setting properly header for json-api

        const headers = rm.getHeaders();

        const uri = rm.buildUri(new this.resource, id);
        return rm.http
            .get(uri, {search: this.buildParameters(), headers: headers})
            .map(res => res.json())
            .map((data) => {
                return {
                    data: rm.extractQueryData(data, this.resource),
                    meta: _.get(data, 'meta')
                }
            });
    }
}

@Injectable()
export class ResourceManager {
    apiUrl: string = 'http://localhost:8000/';

    constructor(public http: Http) {
    }

    from<T extends BaseResource>(r: ResourceType<T>): QueryBuilder {
        return new QueryBuilder(r, this);
    }

    buildUri(resource: any, id?: string): string {
        const resourceMetadata = Reflect.getMetadata('Resource', resource.constructor);
        let apiPath = this.apiUrl;
        const resourceUri = _.get(resourceMetadata, 'uri') ? _.get(resourceMetadata, 'uri') : resourceMetadata.type;
        apiPath += apiPath[apiPath.length - 1] === '/' ? resourceUri : `/${resourceUri}`;
        return id ? `${apiPath}\\${id}` : apiPath;
    }

    extractQueryData<T extends BaseResource>(body: any, modelType: ResourceType<T>): T[] | T {
        let models: T[] = [];

        if (_.isArray(body.data)) {
            body.data.forEach((data: any) => {
                let model: T = new modelType(data);
                models.push(model);
            });
        } else {
            let model = new modelType(body.data);
            if (body.included && _.isArray(body.included))
                model.syncRelationships(body.included);
            return model;
        }
        return models;
    }

    getHeaders() {
        let headers = new Headers();
        headers.append('Content-Type', 'application/vnd.api+json');
        headers.append('Accept', 'application/vnd.api+json');
        return headers;
    }

    /**
     *  Perform create, update or remove resources
     * @param resources
     * @returns {Observable<R>}
     */
    saveCollection<T extends BaseResource>(resources: T[]): Observable<any> {
        const headers = this.getHeaders();
        let observableNewResources: any[] = [];
        let observableModifiedResources: any[] = [];

        let newResources: T[] = [];
        let editResources: T[] = [];

        _.each(resources, (resource: T) => {
            //Grouping dirty resources
            if (resource.isDirty()) {
                observableModifiedResources.push(this.http.patch(this.buildUri(resource, resource.id), resource.toJsonApi([], true), {headers: headers}));
                editResources.push(resource);
            } else if (!resource.id) { //Grouping new resources
                observableNewResources.push(this.http.post(this.buildUri(resource), resource.toJsonApi([]), {headers: headers}));
                newResources.push(resource);
            }
        });

        let create = observableNewResources.length ? Observable.forkJoin(observableNewResources) : Observable.of([]);
        let edit = observableModifiedResources.length ? Observable.forkJoin(observableModifiedResources) : Observable.of([]);

        return Observable.forkJoin(create, edit)
            .map((res) => {
                let response = {
                    data: {
                        created: <T[]> [],
                        edited: <T[]> []
                    }
                };

                // Build created resources objects using response server
                const responseCreatedResources = res[0];
                _.forEach(responseCreatedResources, (res: Response, index: number) => {
                    newResources[index].initAttributes(res.json().data);
                    response.data.created.push(newResources[index]);
                });

                // Build edited resources objects using response server
                const responseEditedResources = res[1];
                _.forEach(responseEditedResources, (res: Response, index: number) => {
                    editResources[index].initAttributes(res.json().data);
                    response.data.edited.push(editResources[index]);
                });
                return response;
            });
    }

    removeCollection<T extends BaseResource>(resources: T[]): Observable<any> {
        const headers = this.getHeaders();
        let observableRemoveResources: any[] = [];

        for (let i in resources)
            observableRemoveResources.push(this.http.delete(this.buildUri(resources[i], resources[i].id), {headers: headers}));

        if(!observableRemoveResources.length)
            observableRemoveResources.push(Observable.of(null));

        return Observable.forkJoin(observableRemoveResources)
            .map((res) => {
                return {
                    data: resources
                };
            });
    }

    initAttributesRelationship<T extends BaseResource>(resources: T[], dataResources: any): T[] {
        let models: T[] = [];
        _.forEach(resources, (resource: T, index: number) => {
            resource.initAttributes(dataResources[index]);
            models.push(resource);
        });
        return models;
    }

    isDirtyCollection<T extends BaseResource>(resources: T[]): boolean {
        for (let i in resources)
            // if doesn't have id or is dirty
            if (resources[i].isDirty() || !resources[i].id)
                return true;
        return false;
    }

    /**
     * Create several relationships
     * @param resource
     * @param relatedResources
     */
    createRelationship<T extends BaseResource>(resource: T, relatedResources: T[]): Observable<any> | any {
        let self: any = this;
        let relationshipsRequest: any[] = [];
        let resourceGroupedByType: any = {};

        // Grouping resources by type
        _.forEach(relatedResources, (item: T) => {
            let {type} = Reflect.getMetadata('Resource', item.constructor);
            let uri = this.buildUri(resource, resource.id) + "/relationships/" + type;
            if (!resourceGroupedByType[type]) {
                resourceGroupedByType[type] = {
                    uri: <string> "",
                    data: <any[]> []
                };
                resourceGroupedByType[type].uri = uri;
                resourceGroupedByType[type].data.push({type: type, id: item.id});
            } else {
                resourceGroupedByType[type].data.push({type: type, id: item.id});
            }
        });

        // Create the observable request
        _.forEach(resourceGroupedByType, (item: any) => {
            relationshipsRequest.push(self.http.post(item.uri, {data: item.data}, self.getHeaders()));
        });

        if (!relationshipsRequest.length)
            relationshipsRequest.push(Observable.of([]));

        return Observable.forkJoin(relationshipsRequest).map(([res]) => {
            let response = (res instanceof Response) ? res.json : res;
            return {
                data: response
            }
        })

    }
}

/**
 * Module for angular-jsonapi
 * @experimental
 */
@NgModule({
    imports: [HttpModule],
    providers: [ResourceManager]
})
export class JsonApiModule {
    constructor(@Optional() @SkipSelf() parentModule: JsonApiModule) {
        if (parentModule) {
            throw new Error(
                'JsonApiModule is already loaded. Import it in the AppModule only');
        }
    }

    static forRoot(config: any): ModuleWithProviders {
        return {
            ngModule: JsonApiModule,
            providers: [
                {provide: ResourceManager, useValue: config}
            ]
        };
    }
}
